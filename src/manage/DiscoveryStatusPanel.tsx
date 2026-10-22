import { useEffect, useRef, useState } from 'react';
import { displayTime } from '../dynamics/DynamicContent';
import type { ManagementApi } from './managementApi';
import type { DiscoveryError, DiscoveryState } from './discoveryState';

const statusLabels = {
  undiscovered: '尚未开始发现。', running: '本轮发现进行中。',
  discovered: '本轮发现成功；不代表归档成功。', failed: '本轮发现未完整完成。',
};
const errors: Record<DiscoveryError, string> = {
  SOURCE_UNAVAILABLE: '来源暂不可用；保留已有可信结果。',
  SIGNAL_INVALID: '发现响应解析失败；保留已有可信结果。',
  PAGINATION_INVALID: '分页未完整完成；保留已有可信结果。',
  DISCOVERY_STOPPED: '配置已改变，本轮发现已停止。',
  DISCOVERY_INTERRUPTED: '发现进程中断，本轮未完成。',
};
function TargetIds({ ids, label }: { ids: readonly string[]; label: string }) {
  return <ul className="manage-targets" aria-label={label}>{ids.map(id => <li key={id}><span>{id}</span></li>)}</ul>;
}

/** 手动读取持久发现状态，不启动发现、归档或轮询。 */
export function DiscoveryStatusPanel({ uid, api }: { uid: string; api: ManagementApi }) {
  const [state, setState] = useState<DiscoveryState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setState(null); setError(''); setLoading(false);
    return () => { request.current?.abort(); request.current = null; };
  }, [uid, api]);
  async function load() {
    if (request.current) return;
    const current = new AbortController();
    request.current = current;
    setLoading(true); setError('');
    const result = await api.getDiscovery({ uid, signal: current.signal });
    if (current.signal.aborted || request.current !== current) return;
    request.current = null; setLoading(false);
    if (result.status === 'success') setState(result.data);
    else if (result.status === 'error') setError(result.message);
  }
  return <section className="manage-section manage-checks" aria-label="近期发现与当前窗口">
    <h2>近期发现与当前窗口</h2>
    <p className="manage-muted">仅读取已保存状态，不触发发现、检查或同步；不自动轮询。</p>
    <button type="button" disabled={loading} onClick={() => void load()}>
      {loading ? '正在读取发现状态…' : state === null ? '读取发现状态' : '重新读取发现状态'}
    </button>
    {state === null && !loading && <p>尚未读取发现状态。</p>}
    {error && <p role="alert">{error}</p>}
    {state && <>
      <p>读取时已保存模式：{state.mode === null ? '无配置' : state.mode === 'recent' ? '近期 N 条' : '指定动态 ID'}{state.mode === 'recent' && <>；N：{state.recentN ?? '—'}</>}；监控：{state.enabled ? '已启用' : '已停止'}。</p>
      <p>{statusLabels[state.status]}</p>
      {!state.active && <p>近期发现当前未启用；历史结果仍可读取。</p>}
      {state.incomplete && <p>发现未完成；保留已有可信结果与已发布窗口。</p>}
      {state.retryable && <p>可在下一固定节拍重试；页面重读不会启动发现。</p>}
      {state.active && !state.incomplete && <p>发现窗口已就绪；内容归档请另读检查状态。</p>}
      {state.attempt && <section className="manage-check" aria-label="本轮发现尝试">
        <h3>本轮累计候选（不代表已发布）</h3>
        <p>本轮 N：{state.attempt.recentN}；开始：{displayTime(state.attempt.startedAt)}</p>
        <p>本轮完成：{state.attempt.finishedAt ? displayTime(state.attempt.finishedAt) : '未完成'}</p>
        <TargetIds ids={state.attempt.ids} label="本轮累计候选" />
        {state.attempt.error && <p className="manage-state-error" role="status">发现错误：{errors[state.attempt.error]}</p>}
      </section>}
      <section className="manage-check" aria-label="最近可信发现结果">
        <h3>最近可信发现目标（历史结果）</h3>
        {state.trustedResult ? <>
          <p>可信结果 N：{state.trustedResult.recentN}；发现时间：{displayTime(state.trustedResult.discoveredAt)}</p>
          <p>{state.trustedResult.exhausted ? '该轮来源已耗尽；结果保持来源次序。' : '该轮达到 N 后停止扫描；不保证历史已耗尽。'}</p>
          {state.trustedResult.ids.length === 0 && <p>可信成功空结果；不等于发现失败。</p>}
          <TargetIds ids={state.trustedResult.ids} label="最近可信发现目标" />
        </> : <p>尚无完整成功的可信发现结果。</p>}
      </section>
      <section className="manage-check" aria-label="当前近期窗口">
        <h3>当前启用近期目标（已发布窗口）</h3>
        <p className="manage-muted">与历史可信发现结果分开；入选不代表归档完成。</p>
        {state.currentIds.length === 0 && <p>当前无启用的近期目标；不表示历史归档已删除。</p>}
        <TargetIds ids={state.currentIds} label="当前启用近期目标" />
      </section>
    </>}
  </section>;
}
