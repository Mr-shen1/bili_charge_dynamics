import { useEffect, useRef, useState } from 'react';
import { displayTime } from '../dynamics/DynamicContent';
import type { ManagementApi, Monitor } from './managementApi';
import type { CheckError, ManagedCheck } from './checkStatus';
import { commentSyncErrors as commentErrors } from '../data/commentSyncErrors';

const checkLabels = { unchecked: '未检查', checked: '已检查，已登记观察。', unchanged: '检查无变化；不代表同步完成。', failed: '检查失败' };
const partLabels = { pending: '待处理', success: '已保存', restricted: '受限', failed: '失败' };
const attemptLabels = { pending: '待处理', success: '成功', failed: '失败', unconfirmed: '未确认' };
const errors: Record<CheckError, string> = {
  SOURCE_UNAVAILABLE: '来源暂不可用。', SIGNAL_INVALID: '编辑信号解析失败；保留已有可信值。',
  SYNC_INCOMPLETE: '同步未全部完成，将在固定节拍重试。',
};
function CheckStatus({ check }: { check: ManagedCheck }) {
  const partial = Object.values(check.parts).some(state => state === 'success');
  const partsComplete = Object.values(check.parts).every(state => state === 'success');
  const versionMismatch = check.observedVersion !== check.syncedVersion;
  const commentParts = [check.parts.comments, check.parts.replies];
  const commentsComplete = commentParts.every(state => state === 'success');
  const commentPartErrors = [check.rootCommentsError, check.repliesError, check.commentsError];
  const commentsFailed = commentParts.some(state => state === 'failed') || check.commentsLastAttempt === 'failed'
    || commentPartErrors.some(error => error === 'ROOT_COMMENTS_FAILED' || error === 'REPLIES_FAILED');
  const commentsUnconfirmed = check.commentsLastAttempt === 'unconfirmed'
    || commentPartErrors.includes('COMMENT_LOCATOR_UNCONFIRMED');
  const commentsProgress = check.checkStatus === 'unchecked' ? '未检查'
    : commentsComplete ? '对应评论观察已完成'
    : check.work === 'running' ? '同步中'
    : commentParts.some(state => state === 'success') ? '部分完成'
    : commentsFailed ? '失败，待重试'
    : commentsUnconfirmed ? '未确认' : '待处理';
  return <section className="manage-check" aria-label={`动态 ${check.id} 检查状态`}>
    <h3>动态 {check.id}</h3>
    <p>{check.active ? '已纳入检查' : '已停止或移出；保留已有归档与未完成工作。'}</p>
    <p className={check.checkStatus === 'failed' ? 'manage-state-error' : 'manage-check-label'}>{checkLabels[check.checkStatus]}</p>
    <p>{check.checkStatus === 'unchecked' ? '尚无检查工作' : check.work === 'running' ? '同步中'
      : check.work === 'complete' ? '对应观察已完成'
      : partsComplete ? '分项已完成，整轮待确认'
      : partial ? '部分完成' : check.syncError ? '同步失败，待重试' : '待同步'}</p>
    {versionMismatch && <p>观察与正文成功版本不一致；当前观察仍待同步确认。</p>}
    {check.editStatus === 'unknown' && <p>编辑信号未知；不代表确认未编辑。</p>}
    {check.editStatus === 'error' && <p>编辑信号错误；保留已有可信值。</p>}
    <p>来源评论总数：{check.sourceCommentCount ?? '—'}</p>
    <p>本地根评论数：{check.localCommentCount ?? '—'}</p>
    <p>本地回复数：{check.localReplyCount ?? '—'}</p>
    <p>评论计数检查：{check.commentCountStatus === 'observed' ? '已观察'
      : check.commentCountStatus === 'failed' ? '失败；保留已有可信数。' : '未检查或未知'}</p>
    <p>评论整轮成功计数（来源总数）：{check.syncedCommentCount ?? '—'}</p>
    <p>评论整轮最近尝试：{check.commentsLastAttempt === null ? '未知' : attemptLabels[check.commentsLastAttempt]}</p>
    <p>评论同步：{commentsProgress}</p>
    {check.sourceCommentCount !== check.syncedCommentCount
      && <p>来源计数与评论整轮成功计数不一致；当前观察仍待评论同步确认。</p>}
    <p>正文{partLabels[check.parts.text]}；动态图{partLabels[check.parts.media]}；评论{partLabels[check.parts.comments]}；回复{partLabels[check.parts.replies]}；评论图{partLabels[check.parts.comment_media]}。</p>
    <p>最近检查：{check.lastCheckedAt ? displayTime(check.lastCheckedAt) : '未检查'}</p>
    <p>实际整轮成功：{check.lastSucceededAt ? displayTime(check.lastSucceededAt) : '尚未成功'}</p>
    <p>根评论最近成功：{check.rootCommentsLastSucceededAt ? displayTime(check.rootCommentsLastSucceededAt) : '—'}</p>
    <p>回复最近成功：{check.repliesLastSucceededAt ? displayTime(check.repliesLastSucceededAt) : '—'}</p>
    <p>评论整轮最近成功：{check.commentsLastSucceededAt ? displayTime(check.commentsLastSucceededAt) : '—'}</p>
    <p className="manage-muted">历史分项成功时间不代表当前观察已完成；未知时间不补造。</p>
    {check.rootCommentsError && <p className="manage-state-error" role="status">根评论：{commentErrors[check.rootCommentsError]}</p>}
    {check.repliesError && <p className="manage-state-error" role="status">回复：{commentErrors[check.repliesError]}</p>}
    {check.commentsError && <p className="manage-state-error" role="status">评论整轮：{commentErrors[check.commentsError]}</p>}
    {check.checkError && <p className="manage-state-error" role="status">检查：{errors[check.checkError]}</p>}
    {check.syncError && <p className="manage-state-error" role="status">同步：{errors[check.syncError]}</p>}
  </section>;
}

/** 手动读取持久状态，不轮询，也不调用同步接口。 */
export function CheckStatusPanel({ uid, api, monitor }: { uid: string; api: ManagementApi; monitor: Monitor | null }) {
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
  return <section className="manage-section manage-checks" aria-label="目标检查与归档状态">
    <h2>目标检查与归档状态</h2>
    <div className="manage-check-times">
      <p>最近检查：{monitor?.lastCheckedAt ? displayTime(monitor.lastCheckedAt) : '未检查'}</p>
      <p>最近成功：{monitor?.lastSucceededAt ? displayTime(monitor.lastSucceededAt) : '尚未成功'}</p>
    </div>
    <p className="manage-muted">以上为该 UP 历史目标记录的最近时间，不代表全部目标均已成功。</p>
    <p className="manage-muted">仅读取已保存状态，不触发检查或同步；停用后的记录仍可读取。</p>
    <p className="manage-muted">来源总数含根评论和回复；本地数是保留归档量，不是当前已加载数，也不代表全部来源评论。</p>
    <p className="manage-muted">除初始化和失败重试外，仅按来源总数变化同步评论；增删抵消、纯评论编辑或分页移动且总数不变可能漏检，不保证实时或所有受限评论可读。</p>
    <button type="button" disabled={loading} onClick={() => void load()}>
      {loading ? '正在读取检查状态…' : checks === null ? '读取检查状态' : '重新读取检查状态'}
    </button>
    {checks === null && !loading && <p>尚未读取检查状态。</p>}
    {error && <p role="alert">{error}</p>}
    {checks?.length === 0 && <p>尚无目标检查记录。</p>}
    {checks?.map(check => <CheckStatus key={check.id} check={check} />)}
  </section>;
}
