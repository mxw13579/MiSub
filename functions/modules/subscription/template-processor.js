import { groupNodeLinesByRegion } from './region-groups.js';

/**
 * 解析并扩展策略组中的正则过滤器
 * @param {Object} model - 统一模板模型
 */
function resolveGroupFilters(model) {
    const proxyNames = model.proxies.map(p => p.name || p.tag).filter(Boolean);
    if (proxyNames.length === 0) return;

    model.groups.forEach(group => {
        if (!Array.isArray(group.filters) || group.filters.length === 0) return;

        group.members = group.members || [];
        const currentMembers = new Set(group.members);

        group.filters.forEach(filter => {
            if (filter === '.*') {
                proxyNames.forEach(name => currentMembers.add(name));
                return;
            }

            try {
                const regex = new RegExp(filter, 'i');
                const isAutoGroup = ['url-test', 'fallback', 'load-balance'].includes(String(group.type || '').toLowerCase());
                proxyNames.forEach(name => {
                    if (isAutoGroup && isInfoAnnouncementNode(name)) return;
                    if (regex.test(name)) {
                        currentMembers.add(name);
                    }
                });
            } catch (e) {
                console.warn(`[Template Processor] Invalid regex filter: ${filter}`, e);
            }
        });

        group.members = Array.from(currentMembers);
    });
}

/**
 * 递归修剪所有成员为空的策略组，并清理相关引用
 * @param {Object} model - 统一模板模型
 */
function pruneEmptyGroups(model) {
    let changed = true;
    while (changed) {
        changed = false;
        const emptyGroupNames = new Set(
            model.groups
                .filter(g => (!Array.isArray(g.members) || g.members.length === 0))
                .map(g => g.name)
        );

        if (emptyGroupNames.size === 0) break;

        // 1. 移除空组本身
        const initialCount = model.groups.length;
        model.groups = model.groups.filter(g => !emptyGroupNames.has(g.name));
        if (model.groups.length !== initialCount) changed = true;

        // 2. 从其它组的成员列表中移除对空组的引用
        model.groups.forEach(group => {
            if (Array.isArray(group.members)) {
                const newMembers = group.members.filter(m => !emptyGroupNames.has(m));
                if (newMembers.length !== group.members.length) {
                    group.members = newMembers;
                    changed = true;
                }
            }
        });

        // 3. 从规则列表中移除指向空组的规则
        const initialRuleCount = model.rules.length;
        model.rules = model.rules.filter(rule => !emptyGroupNames.has(rule.policy));
        if (model.rules.length !== initialRuleCount) changed = true;
    }
}

function normalizeGroupSemanticName(name = '') {
    return String(name)
        .replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '')
        .replace(/[\s_-]+/g, '')
        .replace(/节点/g, '')
        .toLowerCase();
}

function hasEquivalentRegionGroup(model, region) {
    const regionTags = new Set(region.tags || []);
    const normalizedRegionName = normalizeGroupSemanticName(region.name);

    return model.groups.some(group => {
        const normalizedGroupName = normalizeGroupSemanticName(group.name);
        if (normalizedGroupName === normalizedRegionName) return true;

        const members = Array.isArray(group.members) ? group.members : [];
        if (members.length === 0) return false;

        const overlapCount = members.filter(member => regionTags.has(member)).length;
        return overlapCount > 0 && overlapCount === members.length && overlapCount === regionTags.size;
    });
}

function dedupeGroupsByName(model) {
    const mergedGroups = [];
    const seen = new Map();

    model.groups.forEach(group => {
        const name = String(group.name || '').trim();
        if (!name) return;

        if (!seen.has(name)) {
            const normalized = {
                ...group,
                name,
                members: Array.isArray(group.members) ? Array.from(new Set(group.members.filter(Boolean))) : [],
                filters: Array.isArray(group.filters) ? Array.from(new Set(group.filters.filter(Boolean))) : [],
                options: typeof group.options === 'object' && group.options !== null ? { ...group.options } : {}
            };
            seen.set(name, normalized);
            mergedGroups.push(normalized);
            return;
        }

        const existing = seen.get(name);
        existing.members = Array.from(new Set([...(existing.members || []), ...((group.members || []).filter(Boolean))]));
        existing.filters = Array.from(new Set([...(existing.filters || []), ...((group.filters || []).filter(Boolean))]));
        existing.options = {
            ...(existing.options || {}),
            ...((typeof group.options === 'object' && group.options !== null) ? group.options : {})
        };

        if ((!existing.type || existing.type === 'select') && group.type) {
            existing.type = group.type;
        }
    });

    model.groups = mergedGroups;
}

const REGION_PRIORITY_ORDER = [
    '香港', '台湾', '日本', '新加坡', '美国', '韩国', '英国', '德国', '法国', '加拿大', '澳大利亚', '荷兰', '俄罗斯', '印度', '土耳其'
];

// 核心常驻独立分组地区（即使只剩 1~2 个节点也独立成组）；非核心冷门小国若节点数 <= 2 自动归并至「🌏 其他地区」
const CORE_STANDALONE_REGIONS = new Set([
    '香港', '台湾', '日本', '新加坡', '美国', '韩国', '英国', '德国'
]);
const MINOR_REGION_MERGE_MAX_NODES = 2;

const INFO_NODE_FILTER_REGEX = /(剩余流量|流量剩余|距离下次重置|下次重置|套餐到期|到期时间|过期时间|有效期|官网|发布页|防失联|失联|售后|客服|电报群|TG群|没事不要连|更新订阅|订阅专用|全红|https?:\/\/)/i;

function isInfoAnnouncementNode(name = '') {
    return INFO_NODE_FILTER_REGEX.test(String(name || ''));
}

function extractSourcePrefixFromProxyName(name = '') {
    const withoutEmoji = String(name || '')
        .replace(/^(?:[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]{2,}\u{E007F}|[\u{1F30D}-\u{1F30F}])\s*/u, '')
        .trim();
    const dashIndex = withoutEmoji.indexOf('-');
    if (dashIndex <= 0 || dashIndex >= withoutEmoji.length - 1) return null;
    const prefix = withoutEmoji.slice(0, dashIndex).trim();
    if (!prefix || prefix.length > 24) return null;
    return prefix;
}

function buildHiddenAutoHelperGroup(shortLabel, rawMembers, enableAutoFastest) {
    if (!enableAutoFastest) return null;
    const realMembers = (rawMembers || []).filter(
        name => !isInfoAnnouncementNode(name) && !/[iI][pP][vV]6/.test(name)
    );
    if (realMembers.length < 2) return null;

    return {
        name: `⚡ ${shortLabel}-自动最快`,
        type: 'url-test',
        members: realMembers,
        filters: [],
        options: {
            url: 'https://www.gstatic.com/generate_204',
            interval: 120,
            tolerance: 40,
            hidden: true,
            'max-failed-times': 3
        }
    };
}

function injectDynamicSourceAndRegionSelectGroups(model) {
    const hasSourcePlaceholder = model.groups.some(
        g => Array.isArray(g.members) && g.members.includes('<%sourceStrategyChain%>')
    );
    const hasRegionSelectPlaceholder = model.groups.some(
        g => Array.isArray(g.members) && g.members.includes('<%regionSelectChain%>')
    );
    const hasRegionAutoPlaceholder = model.groups.some(
        g => Array.isArray(g.members) && g.members.includes('<%regionAutoChain%>')
    );

    const isClashTarget = String(model.meta?.target || 'clash').toLowerCase() === 'clash';
    const enableAutoFastest = isClashTarget && model.settings?.enableGroupAutoFastest !== false;

    const injectedSourceGroupNames = [];
    const injectedRegionSelectGroupNames = [];
    const injectedRegionAutoTargets = [];
    const hiddenHelperGroups = [];

    if (hasSourcePlaceholder && model.proxies.length > 0) {
        const sourceMap = new Map();
        model.proxies.forEach(proxy => {
            const pName = proxy.name || proxy.tag;
            if (!pName) return;
            const src = extractSourcePrefixFromProxyName(pName);
            if (!src) return;
            if (!sourceMap.has(src)) sourceMap.set(src, []);
            sourceMap.get(src).push(pName);
        });

        // 确保「自建」排在最前面，其余按订阅顺序排列
        const sortedSources = Array.from(sourceMap.keys()).sort((a, b) => {
            if (a === '自建') return -1;
            if (b === '自建') return 1;
            return 0;
        });

        sortedSources.forEach(src => {
            const groupName = src === '自建' ? '🏠 自建' : `📦 ${src}`;
            const rawMembers = sourceMap.get(src);
            const helper = buildHiddenAutoHelperGroup(src, rawMembers, enableAutoFastest);
            if (helper) hiddenHelperGroups.push(helper);

            injectedSourceGroupNames.push(groupName);
            model.groups.push({
                name: groupName,
                type: 'select',
                members: helper ? [helper.name, ...rawMembers] : rawMembers,
                filters: [],
                options: {}
            });
        });
    }

    if ((hasRegionSelectPlaceholder || hasRegionAutoPlaceholder) && model.proxies.length > 0) {
        const nodeEntries = model.proxies
            .filter(p => p && (p.name || p.tag) && !isInfoAnnouncementNode(p.name || p.tag))
            .map(p => ({ tag: p.name || p.tag, metadata: p.metadata }));
        const regions = groupNodeLinesByRegion(nodeEntries);

        regions.sort((a, b) => {
            const cleanA = a.name.replace(/^[^\u4e00-\u9fa5]+/, '').replace(/节点$/, '').replace('狮城', '新加坡');
            const cleanB = b.name.replace(/^[^\u4e00-\u9fa5]+/, '').replace(/节点$/, '').replace('狮城', '新加坡');
            if (cleanA === '其他') return 1;
            if (cleanB === '其他') return -1;
            const idxA = REGION_PRIORITY_ORDER.indexOf(cleanA);
            const idxB = REGION_PRIORITY_ORDER.indexOf(cleanB);
            if (idxA !== -1 && idxB !== -1) return idxA - idxB;
            if (idxA !== -1) return -1;
            if (idxB !== -1) return 1;
            return cleanA.localeCompare(cleanB, 'zh-CN');
        });

        const standaloneRegions = [];
        const mergedOtherTags = [];

        regions.forEach(region => {
            const cleanLabel = region.name
                .replace(/节点$/, '')
                .replace('狮城', '新加坡')
                .trim();
            const shortRegion = cleanLabel.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').trim() || cleanLabel;
            const normalizedShort = shortRegion === '澳洲' ? '澳大利亚' : shortRegion;
            const isCore = CORE_STANDALONE_REGIONS.has(shortRegion) || CORE_STANDALONE_REGIONS.has(normalizedShort);

            if (shortRegion === '其他' || (!isCore && region.tags.length <= MINOR_REGION_MERGE_MAX_NODES)) {
                mergedOtherTags.push(...region.tags);
            } else {
                standaloneRegions.push({ cleanLabel, shortRegion, tags: region.tags });
            }
        });

        if (mergedOtherTags.length > 0) {
            standaloneRegions.push({
                cleanLabel: '🌏 冷门地区',
                shortRegion: '冷门地区',
                tags: mergedOtherTags
            });
        }

        standaloneRegions.forEach(({ cleanLabel, shortRegion, tags }) => {
            const helper = buildHiddenAutoHelperGroup(shortRegion, tags, enableAutoFastest);
            if (helper) {
                hiddenHelperGroups.push(helper);
                injectedRegionAutoTargets.push(helper.name);
            } else {
                const nonIpv6 = tags.find(n => !/[iI][pP][vV]6/.test(n));
                if (nonIpv6) injectedRegionAutoTargets.push(nonIpv6);
            }

            if (hasRegionSelectPlaceholder) {
                injectedRegionSelectGroupNames.push(cleanLabel);
                model.groups.push({
                    name: cleanLabel,
                    type: 'select',
                    members: helper ? [helper.name, ...tags] : tags,
                    filters: [],
                    options: {}
                });
            }
        });
    }

    if (hiddenHelperGroups.length > 0) {
        model.groups.push(...hiddenHelperGroups);
    }

    return { injectedSourceGroupNames, injectedRegionSelectGroupNames, injectedRegionAutoTargets };
}

/**
 * 展开魔法占位符（如 <%regionStrategyChain%> / <%sourceStrategyChain%> / <%regionSelectChain%> / <%regionAutoChain%>）
 * @param {Object} model - 统一模板模型
 */
function expandMagicPlaceholders(model, dynamicChains = {}) {
    const {
        injectedSourceGroupNames = [],
        injectedRegionSelectGroupNames = [],
        injectedRegionAutoTargets = []
    } = dynamicChains;
    const regionNames = Array.from(new Set(
        model.groups
            .filter(g => g.type === 'url-test' && !g.name.includes('自动'))
            .map(g => g.name)
    ));
    
    // 获取协议分组（如果存在）
    const protocolNames = Array.from(new Set(
        model.groups
            .filter(g => g.name.includes('节点') && !regionNames.includes(g.name))
            .map(g => g.name)
    ));

    model.groups.forEach(group => {
        if (!Array.isArray(group.members)) return;

        const newMembers = [];
        group.members.forEach(member => {
            if (member === '<%sourceStrategyChain%>') {
                newMembers.push(...injectedSourceGroupNames);
            } else if (member === '<%regionSelectChain%>') {
                newMembers.push(...injectedRegionSelectGroupNames);
            } else if (member === '<%regionAutoChain%>') {
                newMembers.push(...injectedRegionAutoTargets);
            } else if (member === '<%regionStrategyChain%>') {
                newMembers.push(...regionNames);
            } else if (member === '<%protocolStrategyChain%>') {
                newMembers.push(...protocolNames);
            } else {
                newMembers.push(member);
            }
        });
        group.members = newMembers;
    });
}

/**
 * 清理策略组中指向空组或不存在节点的无效引用
 * @param {Object} model - 统一模板模型
 */
function pruneInvalidMembers(model) {
    const validTargetNames = new Set([
        ...model.proxies.map(p => p.name || p.tag),
        ...model.groups.map(g => g.name),
        'DIRECT', 'REJECT'
    ]);

    model.groups.forEach(group => {
        if (Array.isArray(group.members)) {
            group.members = group.members.filter(m => validTargetNames.has(m));
        }
    });
}

/**
 * 模板模型智能优化器（主入口）
 * 包含：自动解析过滤器、注入地区组、展开占位符、清理无效引用及空组
 * @param {Object} model - 统一模板模型
 */
export function applySmartModelOptimizations(model) {
    const { ruleLevel } = model.meta;
    
    // 1. 执行现有的正则过滤器解析 (始终执行)
    resolveGroupFilters(model);

    // 1.5 动态注入「按来源分组 (<%sourceStrategyChain%>)」与「按国家混合手动组 (<%regionSelectChain%>)」
    const dynamicChains = injectDynamicSourceAndRegionSelectGroups(model);
    const hasCustomRegionSelect = dynamicChains.injectedRegionSelectGroupNames.length > 0;

    // 2. 检查等级。如果是 none (完全禁用) 或已显式启用 <%regionSelectChain%>，跳过默认 url-test 地区组注入
    const normalizedLevel = (ruleLevel || '').toLowerCase();
    
    if (!hasCustomRegionSelect && normalizedLevel !== 'none' && normalizedLevel !== 'base' && normalizedLevel) {
        // 3. 准备获取所有节点的名称，用于后续注入
        const proxyNames = model.proxies.map(p => p.name || p.tag).filter(Boolean);
        if (proxyNames.length > 0) {
            // 4. 识别地区分组并注入
            const nodeEntries = proxyNames.map(name => ({ tag: name }));
            const regions = groupNodeLinesByRegion(nodeEntries);
            
            // 注入地区自动选优组
            regions.forEach(region => {
                if (hasEquivalentRegionGroup(model, region)) return;
                model.groups.push({
                    name: region.name,
                    type: 'url-test',
                    members: region.tags,
                    options: {
                        url: 'http://www.gstatic.com/generate_204',
                        interval: '300',
                        tolerance: '50'
                    }
                });
            });
        }
    }

    // 5. 展开魔法占位符 (始终执行，确保模板标签被替换)
    expandMagicPlaceholders(model, dynamicChains);

    // 6. 只有在非精简模式下才执行主选择器兜底注入
    if (normalizedLevel !== 'none' && normalizedLevel !== 'base' && normalizedLevel) {
        const mainGroupCandidates = model.groups.filter(g => 
            /选择|Proxy|Default|Global|Main|select/i.test(g.name)
        );
        if (mainGroupCandidates.length > 0) {
            const targetGroup = mainGroupCandidates[0];
            // 如果该组还没有任何成员，注入所有可用的组
            if (targetGroup.members.length === 0) {
                const availableGroups = model.groups
                    .filter(g => g.name !== targetGroup.name && (g.type === 'url-test' || g.type === 'fallback'))
                    .map(g => g.name);
                targetGroup.members.push(...availableGroups);
            }
        }
    }

    // 7. 最后进行全局修剪与去重 (始终执行，保证输出质量)
    dedupeGroupsByName(model);
    pruneInvalidMembers(model); 
    pruneEmptyGroups(model);

    return model;
}
