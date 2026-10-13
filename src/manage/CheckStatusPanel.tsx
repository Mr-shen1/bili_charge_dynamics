import { useEffect, useRef, useState } from 'react';
import { displayTime } from '../dynamics/DynamicContent';
import type { ManagementApi } from './managementApi';
import type { CheckError, ManagedCheck } from './checkStatus';

const checkLabels = { unchecked: '未检查', checked: '已检查，已登记观察。', unchanged: '检查无变化；不代表同步完成。', failed: '检查失败' };
const partLabels = { pending: '待处理', success: '已保存', restricted: '受限', failed: '失败' };
const errors: Record<CheckError, string> = {
  SOURCE_UNAVAILABLE: '来源暂不可用。', SIGNAL_INVALID: '编辑信号解析失败；保留已有可信值。',
  SYNC_INCOMPLETE: '同步未全部完成，将在固定节拍重试。',
};
function CheckStatus({ check }: { check: ManagedCheck }) {
  const partial = Object.values(check.parts).some(state => state === 'success');
  const partsComplete = Object.values(check.parts).every(state => state === 'success');
  const versionMismatch = check.observedVersion !== check.syncedVersion;
  return <section aria-label={`动态 ${check.id} 检查状态`}>
    <h3>动态 {check.id}</h3>
    <p>{check.active ? '已纳入检查' : '已停止或移出；保留已有归档与未完成工作。'}</p>
    <p>{checkLabels[check.checkStatus]}</p>
    <p>{check.checkStatus === 'unchecked' ? '尚无检查工作' : check.work === 'running' ? '同步中'
      : check.work === 'complete' ? '对应观察已完成'
      : partsComplete ? '分项已完成，整轮待确认'
      : partial ? '部分完成' : check.syncError ? '同步失败，待重试' : '待同步'}</p>
    {versionMismatch && <p>观察与正文成功版本不一致；当前观察仍待同步确认。</p>}
    {check.editStatus === 'unknown' && <p>编辑信号未知；不代表确认未编辑。</p>}
    {check.editStatus === 'error' && <p>编辑信号错误；保留已有可信值。</p>}
    <p>正文{partLabels[check.parts.text]}；动态图{partLabels[check.parts.media]}；评论{partLabels[check.parts.comments]}；回复{partLabels[check.parts.replies]}；评论图{partLabels[check.parts.comment_media]}。</p>
    <p>最近检查：{check.lastCheckedAt ? displayTime(check.lastCheckedAt) : '未检查'}</p>
    <p>实际整轮成功：{check.lastSucceededAt ? displayTime(check.lastSucceededAt) : '尚未成功'}</p>
    {check.checkError && <p role="status">检查：{errors[check.checkError]}</p>}
    {check.syncError && <p role="status">同步：{errors[check.syncError]}</p>}
  </section>;
}

/** 手动读取持久状态，不轮询，也不调用同步接口。 */
export function CheckStatusPanel({ uid, api }: { uid: string; api: ManagementApi }) {
  const [checks, setChecks] = useState<readonly ManagedCheck[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [uid, api]);
  async function load() {
    if (request.current) return;
    const current = new AbortController();
    request.current = current;
    setLoading(true); setError('');
    const result = await api.listChecks({ uid, signal: current.signal });
    if (current.signal.aborted || request.current !== current) return;
    request.current = null; setLoading(false);
    if (result.status === 'success') setChecks(result.data);
    else if (result.status === 'error') setError(result.message);
  }
  return <section aria-label="目标检查与归档状态">
    <h2>目标检查与归档状态</h2>
    <p className="manage-muted">仅读取已保存状态，不触发检查或同步；停用后的记录仍可读取。</p>
    <button type="button" disabled={loading} onClick={() => void load()}>
      {loading ? '正在读取检查状态…' : checks === null ? '读取检查状态' : '重新读取检查状态'}
    </button>
    {checks === null && !loading && <p>尚未读取检查状态。</p>}
    {error && <p role="alert">{error}</p>}
    {checks?.length === 0 && <p>尚无目标检查记录。</p>}
    {checks?.map(check => <CheckStatus key={check.id} check={check} />)}
  </section>;
}
