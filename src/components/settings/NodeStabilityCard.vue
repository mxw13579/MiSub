<script setup>
import { ref, onMounted, watch } from 'vue';
import SectionHeader from './SectionHeader.vue';
import Input from '../ui/Input.vue';
import { useToastStore } from '../../stores/toast.js';

const props = defineProps({
  settings: {
    type: Object,
    required: true
  }
});

const { showToast } = useToastStore();

const DEFAULT_REGION_LIMITS = [
  { region: '香港', maxLatencyMs: 250 },
  { region: '台湾', maxLatencyMs: 300 },
  { region: '日本', maxLatencyMs: 350 },
  { region: '新加坡', maxLatencyMs: 400 },
  { region: '韩国', maxLatencyMs: 350 },
  { region: '美国', maxLatencyMs: 700 },
  { region: '德国', maxLatencyMs: 600 },
  { region: '英国', maxLatencyMs: 600 }
];

function ensureNodeStabilityDefaults() {
  if (!props.settings) return;
  if (!props.settings.nodeStability || typeof props.settings.nodeStability !== 'object') {
    props.settings.nodeStability = {
      enabled: true,
      enableGroupAutoFastest: true,
      hideInfoNodes: true,
      defaultMaxLatencyMs: 800,
      failStrikeThreshold: 3,
      recoveryCooldownHours: 24,
      probeToken: '',
      regionLatencyLimits: DEFAULT_REGION_LIMITS.map(r => ({ ...r }))
    };
    return;
  }
  const s = props.settings.nodeStability;
  if (s.enabled === undefined) s.enabled = true;
  if (s.enableGroupAutoFastest === undefined) s.enableGroupAutoFastest = true;
  if (s.hideInfoNodes === undefined) s.hideInfoNodes = true;
  if (!s.defaultMaxLatencyMs) s.defaultMaxLatencyMs = 800;
  if (!s.failStrikeThreshold) s.failStrikeThreshold = 3;
  if (!s.recoveryCooldownHours) s.recoveryCooldownHours = 24;
  if (typeof s.probeToken !== 'string') s.probeToken = '';
  if (!Array.isArray(s.regionLatencyLimits)) {
    s.regionLatencyLimits = DEFAULT_REGION_LIMITS.map(r => ({ ...r }));
  }
}

watch(() => props.settings, ensureNodeStabilityDefaults, { immediate: true });

function addRegionLimit() {
  ensureNodeStabilityDefaults();
  props.settings.nodeStability.regionLatencyLimits.push({
    region: '',
    maxLatencyMs: props.settings.nodeStability.defaultMaxLatencyMs || 600
  });
}

function removeRegionLimit(index) {
  ensureNodeStabilityDefaults();
  props.settings.nodeStability.regionLatencyLimits.splice(index, 1);
}

function generateProbeToken() {
  ensureNodeStabilityDefaults();
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(40);
  crypto.getRandomValues(arr);
  props.settings.nodeStability.probeToken = Array.from(arr, b => chars[b % chars.length]).join('');
  showToast('已生成新的探针密钥，请点击页面底部「保存修改」生效', 'info');
}

async function copyProbeToken() {
  const token = props.settings?.nodeStability?.probeToken;
  if (!token) {
    showToast('请先生成探针密钥', 'warning');
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    showToast('探针密钥已复制到剪贴板', 'success');
  } catch {
    showToast('复制失败，请手动选中复制', 'error');
  }
}

const healthLoading = ref(false);
const healthStatus = ref({
  lastReportAt: null,
  stats: { totalTracked: 0, healthyCount: 0, warningCount: 0, quarantinedCount: 0 },
  quarantined: [],
  warnings: []
});

async function loadHealthStatus() {
  healthLoading.value = true;
  try {
    const resp = await fetch('/api/node-health/status', { credentials: 'include' });
    const data = await resp.json();
    if (data && data.success) {
      healthStatus.value = data;
    }
  } catch {
    // ignore load error
  } finally {
    healthLoading.value = false;
  }
}

async function restoreNode(key = '') {
  try {
    const resp = await fetch('/api/node-health/reset', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(key ? { key } : {})
    });
    const data = await resp.json();
    if (data && data.success) {
      showToast(data.message || '操作成功', 'success');
      await loadHealthStatus();
    }
  } catch {
    showToast('恢复失败，请重试', 'error');
  }
}

function formatTime(iso) {
  if (!iso) return '暂无上报记录';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

onMounted(() => {
  ensureNodeStabilityDefaults();
  loadHealthStatus();
});
</script>

<template>
  <div v-if="settings && settings.nodeStability" class="rounded-xl border border-emerald-100 bg-white/90 p-6 shadow-sm dark:border-emerald-500/20 dark:bg-gray-900/70 space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <SectionHeader
        title="节点稳定性与分国家延迟治理"
        description="按国家设定最高允许延迟，自动将连续超时或高延迟的不稳定节点从订阅输出中动态剔除，并在各分组首项置顶「⚡ 本组最快」。"
        tone="green"
      >
        <template #icon>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </template>
      </SectionHeader>
      <span class="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
        动态净网
      </span>
    </div>

    <!-- 核心开关 -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <label class="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50/70 px-4 py-3 cursor-pointer dark:border-gray-700 dark:bg-gray-800/50">
        <div>
          <div class="text-sm font-medium text-gray-900 dark:text-white">启用动态失联 / 高延迟剔除</div>
          <div class="text-xs text-gray-500 dark:text-gray-400">开启后自动隐藏已满连续失败次数的慢节点与死节点</div>
        </div>
        <input type="checkbox" v-model="settings.nodeStability.enabled" class="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
      </label>

      <label class="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50/70 px-4 py-3 cursor-pointer dark:border-gray-700 dark:bg-gray-800/50">
        <div>
          <div class="text-sm font-medium text-gray-900 dark:text-white">分组置顶「⚡ 本组最快」</div>
          <div class="text-xs text-gray-500 dark:text-gray-400">在每个来源组与国家组第 1 项置顶隐藏测速组，实时无缝避障</div>
        </div>
        <input type="checkbox" v-model="settings.nodeStability.enableGroupAutoFastest" class="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
      </label>

      <label class="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50/70 px-4 py-3 cursor-pointer dark:border-gray-700 dark:bg-gray-800/50">
        <div>
          <div class="text-sm font-medium text-gray-900 dark:text-white">屏蔽流量 / 到期 / 官网公告伪节点</div>
          <div class="text-xs text-gray-500 dark:text-gray-400">自动剔除机场下发的剩余流量、到期时间、官网地址、防失联等提示条目</div>
        </div>
        <input type="checkbox" v-model="settings.nodeStability.hideInfoNodes" class="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
      </label>
    </div>

    <!-- 全局阈值与探针密钥 -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div>
        <label class="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">全局默认延迟上限 (ms)</label>
        <input
          type="number"
          min="100"
          max="10000"
          v-model.number="settings.nodeStability.defaultMaxLatencyMs"
          class="w-full rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
        />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">连续不及格拉黑次数</label>
        <input
          type="number"
          min="1"
          max="20"
          v-model.number="settings.nodeStability.failStrikeThreshold"
          class="w-full rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
        />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">黑名单自动复检周期 (小时)</label>
        <input
          type="number"
          min="1"
          max="720"
          v-model.number="settings.nodeStability.recoveryCooldownHours"
          class="w-full rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white"
        />
      </div>
    </div>

    <!-- 探针密钥 -->
    <div class="rounded-lg border border-gray-100 bg-gray-50/60 p-4 dark:border-gray-700 dark:bg-gray-800/40 space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <label class="text-xs font-medium text-gray-700 dark:text-gray-300">探针上报专用密钥 (X-Probe-Token)</label>
        <div class="flex items-center gap-2">
          <button type="button" @click="generateProbeToken" class="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700">
            生成随机密钥
          </button>
          <button type="button" @click="copyProbeToken" class="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200">
            复制
          </button>
        </div>
      </div>
      <input
        type="text"
        v-model="settings.nodeStability.probeToken"
        placeholder="点击右上角「生成随机密钥」并保存修改，供本机定时测速探针安全上报"
        class="w-full rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs font-mono text-gray-800 dark:text-gray-200"
      />
    </div>

    <!-- 分国家最大延迟表 -->
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <div>
          <h4 class="text-sm font-semibold text-gray-900 dark:text-white">分国家 / 地区最高延迟阈值</h4>
          <p class="text-xs text-gray-500 dark:text-gray-400">实测延迟超过对应毫秒数即记为一次失联/高延迟，未列出的国家按上方全局默认上限判定。</p>
        </div>
        <button type="button" @click="addRegionLimit" class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors">
          + 添加国家阈值
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div
          v-for="(item, idx) in settings.nodeStability.regionLatencyLimits"
          :key="idx"
          class="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50/70 p-2.5 dark:border-gray-700 dark:bg-gray-800/50"
        >
          <input
            type="text"
            v-model="item.region"
            placeholder="国家，如 香港"
            class="w-20 rounded-md bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-xs text-gray-900 dark:text-white"
          />
          <div class="relative flex-1">
            <input
              type="number"
              min="50"
              max="10000"
              v-model.number="item.maxLatencyMs"
              class="w-full rounded-md bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 pl-2 pr-8 py-1.5 text-xs text-gray-900 dark:text-white"
            />
            <span class="absolute right-2 top-1.5 text-[11px] text-gray-400">ms</span>
          </div>
          <button
            type="button"
            @click="removeRegionLimit(idx)"
            class="rounded-md px-2 py-1.5 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
            title="删除"
          >
            ✕
          </button>
        </div>
      </div>
    </div>

    <!-- 实时探测与屏蔽状态看板 -->
    <div class="rounded-lg border border-gray-100 bg-gray-50/50 p-4 dark:border-gray-700 dark:bg-gray-800/40 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="text-xs text-gray-600 dark:text-gray-300">
          <span class="font-semibold">最近巡检时间：</span>{{ formatTime(healthStatus.lastReportAt) }}
        </div>
        <div class="flex items-center gap-2">
          <button type="button" @click="loadHealthStatus" :disabled="healthLoading" class="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200">
            {{ healthLoading ? '刷新中...' : '刷新状态' }}
          </button>
          <button
            v-if="healthStatus.stats?.quarantinedCount > 0 || healthStatus.stats?.warningCount > 0"
            type="button"
            @click="restoreNode('')"
            class="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-500/30 dark:bg-gray-800 dark:text-red-300"
          >
            清空屏蔽记录
          </button>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-3 text-center">
        <div class="rounded-lg bg-emerald-50/80 dark:bg-emerald-900/20 p-2.5">
          <div class="text-lg font-bold text-emerald-600 dark:text-emerald-400">{{ healthStatus.stats?.healthyCount || 0 }}</div>
          <div class="text-[11px] text-gray-500 dark:text-gray-400">稳定达标节点</div>
        </div>
        <div class="rounded-lg bg-amber-50/80 dark:bg-amber-900/20 p-2.5">
          <div class="text-lg font-bold text-amber-600 dark:text-amber-400">{{ healthStatus.stats?.warningCount || 0 }}</div>
          <div class="text-[11px] text-gray-500 dark:text-gray-400">待观察 (偶发超时/慢)</div>
        </div>
        <div class="rounded-lg bg-red-50/80 dark:bg-red-900/20 p-2.5">
          <div class="text-lg font-bold text-red-600 dark:text-red-400">{{ healthStatus.stats?.quarantinedCount || 0 }}</div>
          <div class="text-[11px] text-gray-500 dark:text-gray-400">已动态屏蔽失联节点</div>
        </div>
      </div>

      <div v-if="healthStatus.quarantined?.length" class="max-h-52 overflow-y-auto space-y-1.5 pt-1">
        <div class="text-xs font-semibold text-red-600 dark:text-red-400">当前已从订阅隐藏的节点 ({{ healthStatus.quarantined.length }})：</div>
        <div
          v-for="node in healthStatus.quarantined"
          :key="node.key"
          class="flex items-center justify-between gap-2 rounded-md bg-white dark:bg-gray-900 px-3 py-1.5 text-xs border border-red-100 dark:border-red-500/20"
        >
          <div class="truncate">
            <span class="font-medium text-gray-800 dark:text-gray-200">{{ node.name }}</span>
            <span class="ml-2 text-red-500">{{ node.lastReason }}（连挂 {{ node.strikes }} 次）</span>
          </div>
          <button type="button" @click="restoreNode(node.key)" class="shrink-0 text-emerald-600 hover:underline">
            立即恢复
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
