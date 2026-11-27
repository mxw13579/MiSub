import yaml from 'js-yaml';
import { clashFix } from '../../../utils/format-utils.js';
import { normalizeUnifiedTemplateModel } from '../template-model.js';

function mapGroupType(type) {
    const normalized = String(type || '').trim().toLowerCase();
    if (normalized === 'url-test' || normalized === 'fallback' || normalized === 'load-balance' || normalized === 'select') {
        return normalized;
    }
    return 'select';
}

function filterAutoSelectMembers(group) {
    const type = mapGroupType(group.type);
    const members = Array.isArray(group.members) ? group.members.filter(Boolean) : [];
    if (!['url-test', 'fallback', 'load-balance'].includes(type)) {
        return members;
    }
    return members.filter(member => !['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'].includes(String(member).toUpperCase()));
}

const ACL4SSR_ROOT_PROVIDER_FILES = new Set([
    'apple',
    'banad',
    'baneasylist',
    'baneasylistchina',
    'baneasyprivacy',
    'banprogramad',
    'chinacompanyip',
    'chinadomain',
    'chinaip',
    'chinaipv6',
    'chinamedia',
    'download',
    'localareanetwork',
    'mjj',
    'proxylite',
    'proxygfwlist',
    'proxymedia',
    'unban'
]);

const ACL4SSR_IPCIDR_PROVIDER_FILES = new Set([
    'amazonip',
    'chinacompanyip',
    'chinaip',
    'chinaipv6',
    'netflixip'
]);

// ACL4SSR root list files that should stay as text providers because their YAML provider is missing
// or does not preserve the effective raw .list rule coverage.
const ACL4SSR_ROOT_LIST_ONLY_FILES = new Set([
    'localareanetwork',
    'banad',
    'banprogramad',
    'chinamedia',
    'proxymedia',
    'chinadomain',
    'download',
    'unban'
]);

function toClashRuleProviderUrl(sourceUrl) {
    if (!/^https?:\/\//i.test(String(sourceUrl || ''))) return sourceUrl;

    try {
        const url = new URL(sourceUrl);
        if (!/raw\.githubusercontent\.com$/i.test(url.hostname)) return sourceUrl;
        const pathParts = url.pathname.split('/').filter(Boolean);
        const owner = pathParts[0] || '';
        const repo = pathParts[1] || '';
        if (owner.toLowerCase() !== 'acl4ssr' || repo.toLowerCase() !== 'acl4ssr') return sourceUrl;
        if (!/\/Clash\/.*\.(list|txt)$/i.test(url.pathname)) return sourceUrl;

        const fileName = url.pathname.split('/').pop()?.replace(/\.(list|txt)$/i, '') || '';
        if (/\/Clash\/[^/]+\.(list|txt)$/i.test(url.pathname) && ACL4SSR_ROOT_LIST_ONLY_FILES.has(fileName.toLowerCase())) {
            return sourceUrl;
        }

        if (/\/Clash\/Ruleset\//i.test(url.pathname)) {
            url.pathname = url.pathname
                .replace(/\/Clash\/Ruleset\//i, '/Clash/Providers/Ruleset/')
                .replace(/\.(list|txt)$/i, '.yaml');
        } else if (ACL4SSR_ROOT_PROVIDER_FILES.has(fileName.toLowerCase())) {
            url.pathname = url.pathname
                .replace(/\/Clash\//i, '/Clash/Providers/')
                .replace(/\.(list|txt)$/i, '.yaml');
        } else {
            url.pathname = url.pathname
                .replace(/\/Clash\//i, '/Clash/Providers/Ruleset/')
                .replace(/\.(list|txt)$/i, '.yaml');
        }

        return url.toString();
    } catch {
        return sourceUrl;
    }
}

function getRuleProviderBehavior(providerUrl) {
    try {
        const fileName = new URL(providerUrl).pathname.split('/').pop()?.replace(/\.(yaml|yml|list|txt|conf)$/i, '') || '';
        if (ACL4SSR_IPCIDR_PROVIDER_FILES.has(fileName.toLowerCase())) return 'ipcidr';
    } catch {
        // ignore invalid provider url shapes and keep default behavior
    }
    return 'classical';
}

function hasNoResolve(rule) {
    return Array.isArray(rule.extras) && rule.extras.some(extra => String(extra).trim().toLowerCase() === 'no-resolve');
}

function mapRule(rule, ruleProviderMap, ruleProviders = {}) {
    const type = String(rule.type || '').toUpperCase();
    if (!type) return null;
    if (type === 'MATCH' || type === 'FINAL') return `MATCH,${rule.policy}`;
    const noResolveSuffix = hasNoResolve(rule) ? ',no-resolve' : '';
    if (type === 'GEOIP') return `GEOIP,${rule.value || 'CN'},${rule.policy}${noResolveSuffix || ',no-resolve'}`;
    if (type === 'RULE-SET') {
        const providerName = ruleProviderMap.get(rule.value);
        const resolvedName = providerName || rule.value;
        const isIpCidrProvider = ruleProviders[resolvedName]?.behavior === 'ipcidr';
        const suffix = noResolveSuffix || (isIpCidrProvider ? ',no-resolve' : '');
        return `RULE-SET,${resolvedName},${rule.policy}${suffix}`;
    }
    if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
        return `${type},${rule.value},${rule.policy}${noResolveSuffix || ',no-resolve'}`;
    }
    return `${type},${rule.value},${rule.policy}${noResolveSuffix}`;
}

export function renderClashFromTemplateModel(model) {
    const normalizedModel = normalizeUnifiedTemplateModel(model);

    const primaryProxyGroup =
        normalizedModel.groups.find(g => /节点选择|Proxy|Select/i.test(g.name))?.name ||
        normalizedModel.groups.find(g => mapGroupType(g.type) === 'select')?.name;

    const ruleProviders = {};
    const ruleProviderMap = new Map();
    let providerCounter = 0;

    normalizedModel.rules.forEach(rule => {
        const type = String(rule.type || '').toUpperCase();
        if (type !== 'RULE-SET' || !rule.value || !/^https?:\/\//i.test(rule.value)) return;

        const providerUrl = toClashRuleProviderUrl(rule.value);
        if (ruleProviderMap.has(providerUrl)) return;

        let nameHint = 'rs';
        try {
            const urlPath = new URL(providerUrl).pathname;
            const fileName = urlPath.split('/').pop()?.replace(/\.(yaml|yml|list|txt|conf)$/i, '') || '';
            if (fileName) {
                nameHint = fileName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            }
        } catch {
            // ignore invalid provider url shapes and keep fallback name
        }

        const providerName = `${nameHint}_${providerCounter++}`;
        ruleProviderMap.set(providerUrl, providerName);
        const usesTextList = /\.(list|txt)$/i.test(providerUrl);
        ruleProviders[providerName] = {
            type: 'http',
            behavior: getRuleProviderBehavior(providerUrl),
            url: providerUrl,
            path: `./ruleset/${providerName}.${usesTextList ? 'list' : 'yaml'}`,
            interval: 86400,
            ...(primaryProxyGroup ? { proxy: primaryProxyGroup } : {}),
            ...(usesTextList ? { format: 'text' } : {})
        };
    });

    const config = {
        'mixed-port': 7890,
        'allow-lan': true,
        'mode': 'rule',
        'log-level': 'info',
        'ipv6': true,
        'unified-delay': true,
        'tcp-concurrent': true,
        'find-process-mode': 'strict',
        'external-controller': ':9090',
        'sniffer': {
            'enable': true,
            'parse-pure-ip': true,
            'force-dns-mapping': true,
            'override-destination': false,
            'sniff': {
                'HTTP': {
                    'ports': [80, '8080-8880'],
                    'override-destination': true
                },
                'TLS': {
                    'ports': [443, 8443]
                },
                'QUIC': {
                    'ports': [443, 8443]
                }
            },
            'skip-domain': [
                'Mijia Cloud',
                '+.push.apple.com',
                '+.oray.com',
                '+.oray.net'
            ]
        },
        'dns': {
            'enable': true,
            'ipv6': false,
            'listen': '0.0.0.0:1053',
            'default-nameserver': ['223.5.5.5', '119.29.29.29'],
            'proxy-server-nameserver': [
                'https://dns.alidns.com/dns-query',
                'https://doh.pub/dns-query'
            ],
            'enhanced-mode': 'fake-ip',
            'fake-ip-range': '198.18.0.1/16',
            'fake-ip-filter': [
                '*.lan',
                '*.local',
                '*.localhost',
                '+.msftconnecttest.com',
                '+.msftncsi.com',
                'localhost.ptlogin2.qq.com',
                'localhost.sec.qq.com',
                '+.oray.com',
                '+.oray.net',
                '+.srv.nintendo.net',
                '+.stun.playstation.net',
                'xbox.*.microsoft.com',
                '+.xboxlive.com',
                '+.battlenet.com.cn',
                'stun.*.*',
                'stun.*.*.*',
                'time.*.com',
                'time.*.gov',
                'time.*.apple.com',
                'ntp.*.com'
            ],
            'nameserver': [
                'https://dns.alidns.com/dns-query',
                'https://doh.pub/dns-query'
            ]
        },
        'proxies': normalizedModel.proxies,
        'proxy-groups': normalizedModel.groups
            .filter(group =>
                (Array.isArray(group.members) && group.members.length > 0) ||
                (Array.isArray(group.filters) && group.filters.length > 0)
            )
            .map(group => {
                const mappedType = mapGroupType(group.type);
                const isAutoGroup = ['url-test', 'fallback', 'load-balance'].includes(mappedType);
                return {
                    name: group.name,
                    type: mappedType,
                    proxies: filterAutoSelectMembers(group),
                    filter: Array.isArray(group.filters) && group.filters.length > 0 ? group.filters.join('|') : undefined,
                    ...(isAutoGroup ? { lazy: true } : {}),
                    ...group.options
                };
            }),
        'rule-providers': Object.keys(ruleProviders).length > 0 ? ruleProviders : undefined,
        'rules': normalizedModel.rules.map(rule => {
            if (String(rule.type || '').toUpperCase() !== 'RULE-SET' || !rule.value) {
                return mapRule(rule, ruleProviderMap, ruleProviders);
            }
            return mapRule({ ...rule, value: toClashRuleProviderUrl(rule.value) }, ruleProviderMap, ruleProviders);
        }).filter(Boolean),
        'profile': {
            'store-selected': true,
            'subscription-url': normalizedModel.settings.managedConfigUrl || ''
        }
    };

    let yamlStr = yaml.dump(config, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        quotingType: '"',
        forceQuotes: false
    });
    yamlStr = clashFix(yamlStr);
    return yamlStr;
}
