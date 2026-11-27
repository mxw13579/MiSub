import { StorageFactory } from '../storage-adapter.js';
import { KV_KEY_SETTINGS, KV_KEY_NODE_HEALTH, DEFAULT_SETTINGS } from './config.js';
import { createJsonResponse, createErrorResponse, readJsonWithLimit, JSON_BODY_LIMITS } from './utils.js';
import { authMiddleware } from './auth-middleware.js';
import { extractNodeMetadata } from './utils/metadata-extractor.js';
import { clearAllNodeCaches } from '../services/node-cache-service.js';

const INFO_NODE_REGEX = /(剩余流量|距离下次重置|套餐到期|到期时间|官网|防失联|售后|没事不要连|更新订阅|流量剩余|过期时间)/i;

export function normalizeNodeHealthKey(rawName = '') {
    return String(rawName || '')
        .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '')
        .replace(/\u{1F3F4}[\u{E0061}-\u{E007A}]{2,}\u{E007F}/gu, '')
        .replace(/[\u{1F30D}-\u{1F30F}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function extractNodeNameFromLine(line = '') {
    const trimmed = String(line || '').trim();
    if (!trimmed) return '';

    if (trimmed.toLowerCase().startsWith('vmess://')) {
        try {
            let b64 = trimmed.slice(8).split('#')[0].replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4 !== 0) b64 += '=';
            const decoded = new TextDecoder('utf-8').decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
            const obj = JSON.parse(decoded);
            if (obj?.ps) return String(obj.ps).trim();
        } catch {
            // fallback to fragment
        }
    }

    const hashIdx = trimmed.lastIndexOf('#');
    if (hashIdx === -1) return '';
    const rawFrag = trimmed.slice(hashIdx + 1);
    try {
        return decodeURIComponent(rawFrag).trim();
    } catch {
        return rawFrag.trim();
    }
}

export function normalizeStabilityConfig(raw = {}) {
    const defaults = DEFAULT_SETTINGS.nodeStability;
    const src = raw && typeof raw === 'object' ? raw : {};
    const limits = Array.isArray(src.regionLatencyLimits)
        ? src.regionLatencyLimits
            .map(item => ({
                region: String(item?.region || '').trim(),
                maxLatencyMs: Math.max(50, Math.min(10000, Number(item?.maxLatencyMs) || defaults.defaultMaxLatencyMs))
            }))
            .filter(item => item.region)
        : defaults.regionLatencyLimits;

    return {
        enabled: src.enabled !== false,
        enableGroupAutoFastest: src.enableGroupAutoFastest !== false,
        defaultMaxLatencyMs: Math.max(100, Math.min(10000, Number(src.defaultMaxLatencyMs) || defaults.defaultMaxLatencyMs)),
        failStrikeThreshold: Math.max(1, Math.min(20, Number(src.failStrikeThreshold) || defaults.failStrikeThreshold)),
        recoveryCooldownHours: Math.max(1, Math.min(720, Number(src.recoveryCooldownHours) || defaults.recoveryCooldownHours)),
        probeToken: String(src.probeToken || '').trim(),
        regionLatencyLimits: limits
    };
}

function resolveRegionMaxLatency(region, stabilityConfig) {
    const normalizedRegion = String(region || '').replace(/节点$/, '').replace('狮城', '新加坡').trim();
    if (normalizedRegion) {
        const matched = stabilityConfig.regionLatencyLimits.find(
            item => item.region === normalizedRegion || normalizedRegion.includes(item.region) || item.region.includes(normalizedRegion)
        );
        if (matched) return matched.maxLatencyMs;
    }
    return stabilityConfig.defaultMaxLatencyMs;
}

async function getAdapterAndSettings(env) {
    const storageType = await StorageFactory.getStorageType(env);
    const adapter = StorageFactory.createAdapter(env, storageType);
    const settings = (await adapter.get(KV_KEY_SETTINGS)) || DEFAULT_SETTINGS;
    return {
        adapter,
        settings,
        stability: normalizeStabilityConfig(settings.nodeStability)
    };
}

async function readHealthStore(adapter) {
    const raw = await adapter.get(KV_KEY_NODE_HEALTH);
    if (raw && typeof raw === 'object' && raw.nodes && typeof raw.nodes === 'object') {
        return raw;
    }
    return {
        lastReportAt: null,
        lastSummary: null,
        nodes: {}
    };
}

export async function handleNodeHealthReport(request, env) {
    if (request.method !== 'POST') {
        return createErrorResponse('Method Not Allowed', 405);
    }

    const { adapter, stability } = await getAdapterAndSettings(env);
    const headerToken = (request.headers.get('X-Probe-Token') || '').trim();
    const isCookieAuthed = await authMiddleware(request, env);
    const isTokenAuthed = Boolean(stability.probeToken && headerToken && headerToken === stability.probeToken);

    if (!isCookieAuthed && !isTokenAuthed) {
        return createJsonResponse({ success: false, error: 'Unauthorized: invalid probe token or session' }, 401);
    }

    let payload;
    try {
        payload = await readJsonWithLimit(request, JSON_BODY_LIMITS.large);
    } catch (e) {
        return createErrorResponse('Invalid JSON payload', 400);
    }

    const results = Array.isArray(payload?.results) ? payload.results : [];
    if (results.length === 0) {
        return createJsonResponse({ success: false, error: 'Empty results array' }, 400);
    }

    const store = await readHealthStore(adapter);
    const nowIso = new Date().toISOString();
    let healthyCount = 0;
    let warningCount = 0;
    let newlyQuarantinedCount = 0;
    let resurrectedCount = 0;

    for (const item of results) {
        const rawName = String(item?.name || '').trim();
        if (!rawName || INFO_NODE_REGEX.test(rawName)) continue;

        const key = normalizeNodeHealthKey(rawName);
        if (!key) continue;

        const meta = extractNodeMetadata(rawName);
        const region = String(item?.region || meta.region || '其他').trim();
        const maxAllowedMs = resolveRegionMaxLatency(region, stability);
        const delay = Number(item?.delay);
        const isTimeout = !Number.isFinite(delay) || delay <= 0;
        const isTooSlow = !isTimeout && delay > maxAllowedMs;

        const prev = store.nodes[key] || {
            name: rawName,
            region,
            strikes: 0,
            quarantined: false,
            quarantinedAt: null,
            lastDelayMs: null,
            maxAllowedMs,
            lastReason: '',
            updatedAt: nowIso
        };

        if (!isTimeout && !isTooSlow) {
            if (prev.quarantined) resurrectedCount++;
            store.nodes[key] = {
                name: rawName,
                region,
                strikes: 0,
                quarantined: false,
                quarantinedAt: null,
                lastDelayMs: Math.round(delay),
                maxAllowedMs,
                lastReason: '正常',
                updatedAt: nowIso
            };
            healthyCount++;
        } else {
            const nextStrikes = (Number(prev.strikes) || 0) + 1;
            const shouldQuarantine = nextStrikes >= stability.failStrikeThreshold;
            if (shouldQuarantine && !prev.quarantined) newlyQuarantinedCount++;

            const reason = isTimeout
                ? '连接超时 (Timeout)'
                : `延迟过高 (${Math.round(delay)}ms > ${maxAllowedMs}ms [${region}])`;

            store.nodes[key] = {
                name: rawName,
                region,
                strikes: nextStrikes,
                quarantined: shouldQuarantine || Boolean(prev.quarantined),
                quarantinedAt: shouldQuarantine && !prev.quarantined ? nowIso : (prev.quarantinedAt || nowIso),
                lastDelayMs: isTimeout ? null : Math.round(delay),
                maxAllowedMs,
                lastReason: reason,
                updatedAt: nowIso
            };

            if (store.nodes[key].quarantined) {
                // counted in totalQuarantined below
            } else {
                warningCount++;
            }
        }
    }

    // 清理超过 14 天未再出现的陈旧节点记录，控制 KV 体积
    const expireCutoff = Date.now() - 14 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(store.nodes)) {
        const ts = Date.parse(v?.updatedAt || '');
        if (Number.isFinite(ts) && ts < expireCutoff) {
            delete store.nodes[k];
        }
    }

    const allEntries = Object.values(store.nodes);
    const totalQuarantined = allEntries.filter(n => n.quarantined).length;

    store.lastReportAt = nowIso;
    store.lastSummary = {
        checkedCount: results.length,
        healthyCount,
        warningCount,
        totalQuarantined,
        newlyQuarantinedCount,
        resurrectedCount
    };

    await adapter.put(KV_KEY_NODE_HEALTH, store);

    if (newlyQuarantinedCount > 0 || resurrectedCount > 0) {
        try {
            await clearAllNodeCaches(adapter);
        } catch {
            // ignore cache clear error
        }
    }

    return createJsonResponse({
        success: true,
        summary: store.lastSummary,
        lastReportAt: store.lastReportAt
    });
}

export async function handleNodeHealthStatus(request, env) {
    const { adapter, stability } = await getAdapterAndSettings(env);
    const store = await readHealthStore(adapter);
    const entries = Object.entries(store.nodes || {}).map(([key, val]) => ({ key, ...val }));

    const quarantined = entries
        .filter(item => item.quarantined)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const warnings = entries
        .filter(item => !item.quarantined && item.strikes > 0)
        .sort((a, b) => b.strikes - a.strikes);
    const healthyCount = entries.filter(item => !item.quarantined && item.strikes === 0).length;

    return createJsonResponse({
        success: true,
        enabled: stability.enabled,
        lastReportAt: store.lastReportAt,
        lastSummary: store.lastSummary,
        stats: {
            totalTracked: entries.length,
            healthyCount,
            warningCount: warnings.length,
            quarantinedCount: quarantined.length
        },
        quarantined,
        warnings
    });
}

export async function handleNodeHealthReset(request, env) {
    if (request.method !== 'POST') {
        return createErrorResponse('Method Not Allowed', 405);
    }
    const { adapter } = await getAdapterAndSettings(env);
    let body = {};
    try {
        body = await readJsonWithLimit(request, JSON_BODY_LIMITS.normal);
    } catch {
        body = {};
    }

    const targetKey = typeof body?.key === 'string' ? body.key.trim() : '';
    const store = await readHealthStore(adapter);

    if (targetKey) {
        delete store.nodes[targetKey];
    } else {
        store.nodes = {};
        store.lastSummary = null;
    }

    await adapter.put(KV_KEY_NODE_HEALTH, store);
    try {
        await clearAllNodeCaches(adapter);
    } catch {
        // ignore
    }

    return createJsonResponse({
        success: true,
        message: targetKey ? '已恢复该节点' : '已清空全部失联屏蔽记录'
    });
}

/**
 * 在生成订阅时过滤已被动态拉黑的失联/高延迟节点
 * 支持探针模式 (?include_dead=1 仅拉取全部节点，或 ?include_recovery=1 拉取正常节点+已满冷却期需复检的节点)
 */
export async function filterQuarantinedNodeLines(combinedNodeList, storageAdapter, config = {}, searchParams = null) {
    if (!combinedNodeList || typeof combinedNodeList !== 'string') return combinedNodeList;

    const stability = normalizeStabilityConfig(config?.nodeStability);
    if (!stability.enabled) return combinedNodeList;

    const includeDeadMode = searchParams?.get('include_dead');
    if (includeDeadMode === 'all' || includeDeadMode === '1') {
        return combinedNodeList;
    }

    let store;
    try {
        store = await readHealthStore(storageAdapter);
    } catch {
        return combinedNodeList;
    }

    const nodeMap = store?.nodes;
    if (!nodeMap || Object.keys(nodeMap).length === 0) return combinedNodeList;

    const includeDueForRecovery = includeDeadMode === 'recovery';
    const cooldownMs = stability.recoveryCooldownHours * 3600 * 1000;
    const now = Date.now();

    const lines = combinedNodeList.split(/\r?\n/);
    const kept = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const nodeName = extractNodeNameFromLine(trimmed);
        if (!nodeName || INFO_NODE_REGEX.test(nodeName)) {
            kept.push(line);
            continue;
        }

        const key = normalizeNodeHealthKey(nodeName);
        const record = key ? nodeMap[key] : null;
        if (!record || !record.quarantined) {
            kept.push(line);
            continue;
        }

        if (includeDueForRecovery) {
            const qTime = Date.parse(record.quarantinedAt || record.updatedAt || '');
            if (!Number.isFinite(qTime) || now - qTime >= cooldownMs) {
                kept.push(line);
            }
        }
    }

    // 安全保底：如果全部节点都被屏蔽，保留原始列表防止订阅完全为空报错
    if (kept.length === 0) return combinedNodeList;
    return kept.join('\n') + '\n';
}
