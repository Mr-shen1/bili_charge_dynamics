import type { DiscoveryError, DiscoveryState } from './discoveryState';

export const discoveryStatusText: Readonly<Record<DiscoveryState['status'], string>> = {
  undiscovered: '尚未开始发现。',
  running: '本轮发现进行中。',
  discovered: '本轮发现成功；不代表内容已保存。',
  failed: '本轮发现未完整完成。',
};
export const discoveryErrorText: Readonly<Record<DiscoveryError, string>> = {
  SOURCE_UNAVAILABLE: '来源暂不可用；保留已有可信结果。',
  SIGNAL_INVALID: '发现响应解析失败；保留已有可信结果。',
  PAGINATION_INVALID: '分页未完整完成；保留已有可信结果。',
  DISCOVERY_STOPPED: '配置已改变，本轮发现已停止。',
  DISCOVERY_INTERRUPTED: '发现进程中断，本轮未完成。',
};

/** 已保存模式只来自读取到的发现状态，不使用页面上未提交的草稿。 */
export function discoveryModeText(discovery: DiscoveryState): string {
  if (discovery.mode === null) return '无配置';
  return discovery.mode === 'recent' ? `近期 N 条；N：${discovery.recentN ?? '—'}` : '指定动态 ID';
}
