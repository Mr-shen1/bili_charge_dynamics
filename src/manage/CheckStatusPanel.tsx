import { useEffect, useId, useRef, useState } from 'react';
import { displayTime } from '../dynamics/DynamicContent';
import type { ManagementApi, Monitor } from './managementApi';
import type { CheckError, MediaSyncError, TargetCheck } from '../data/checkStatus';
import { commentSyncErrors as commentErrors } from '../data/commentSyncErrors';
import { commentProgress, type CommentProgress } from '../data/commentProgress';

const checkLabels = { unchecked: '未检查', checked: '已检查，已登记观察。', unchanged: '检查无变化；不代表同步完成。', failed: '检查失败' };
const partLabels = { pending: '待处理', success: '已保存', restricted: '受限', failed: '失败' };
const attemptLabels = { pending: '待处理', success: '成功', failed: '失败', unconfirmed: '未确认' };
const progressLabels: Record<CommentProgress, string> = { unchecked: '未检查', complete: '对应评论观察已完成',
  running: '同步中', 'partial-failed': '部分完成', partial: '部分完成', failed: '失败，待重试', unconfirmed: '未确认', pending: '待处理' };
const errors: Record<CheckError, string> = {
  SOURCE_UNAVAILABLE: '来源暂不可用。', SIGNAL_INVALID: '编辑信号解析失败；保留已有可信值。',
  SYNC_INCOMPLETE: '同步未全部完成，将在固定节拍重试。',
};
const mediaErrors: Record<MediaSyncError, string> = {
  MEDIA_DOWNLOAD_FAILED: '图片下载失败；保留已有归档，将在固定节拍重试。',
  MEDIA_UPLOAD_FAILED: '图片上传失败；保留已有归档，将在固定节拍重试。',
};
function CheckStatus({ check }: { check: TargetCheck }) {
  // 详情默认折叠：头部只留 ID、纳入状态与检查阶段，避免一屏铺开几十行时间与计数。
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const partial = Object.values(check.parts).some(state => state === 'success');
  const partsComplete = Object.values(check.parts).every(state => state === 'success');
  const versionMismatch = check.observedVersion !== check.syncedVersion;
  const commentsProgress = progressLabels[commentProgress(check)];
  return <section className="manage-check" aria-label={`动态 ${check.id} 检查状态`}>
    <h3>
      {/* 参照 Element Collapse：整行 header 可点击，只保留 ID 与右侧箭头，细节全部收进折叠体。 */}
      <button type="button" className="manage-check-toggle" aria-expanded={expanded} aria-controls={bodyId}
        aria-label={`${expanded ? '收起' : '展开'}动态 ${check.id} 详情`}
        onClick={() => setExpanded(value => !value)}>
        <span className="manage-check-title">动态 {check.id}</span>
        <span className="manage-check-arrow" aria-hidden="true" />
      </button>
    </h3>
    <div id={bodyId} className="manage-check-body" hidden={!expanded}>
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
    <p>正文最近成功：{check.textLastSucceededAt ? displayTime(check.textLastSucceededAt) : '—'}</p>
    <p>动态图最近成功：{check.mediaLastSucceededAt ? displayTime(check.mediaLastSucceededAt) : '—'}</p>
    <p>评论图最近成功：{check.commentMediaLastSucceededAt ? displayTime(check.commentMediaLastSucceededAt) : '—'}</p>
    <p>根评论最近成功：{check.rootCommentsLastSucceededAt ? displayTime(check.rootCommentsLastSucceededAt) : '—'}</p>
    <p>回复最近成功：{check.repliesLastSucceededAt ? displayTime(check.repliesLastSucceededAt) : '—'}</p>
    <p>评论整轮最近成功：{check.commentsLastSucceededAt ? displayTime(check.commentsLastSucceededAt) : '—'}</p>
    <p className="manage-muted">历史分项成功时间不代表当前观察已完成；未知时间不补造。</p>
    <p className="manage-muted">媒体错误来自实际已尝试的归档；无错误记录不代表图片已完成。</p>
    {[...new Set(check.mediaErrors)].map(error => <p key={error} className="manage-state-error" role="status">动态图：{mediaErrors[error]}</p>)}
    {[...new Set(check.commentMediaErrors)].map(error => <p key={error} className="manage-state-error" role="status">评论图：{mediaErrors[error]}</p>)}
    {check.rootCommentsError && <p className="manage-state-error" role="status">根评论：{commentErrors[check.rootCommentsError]}</p>}
    {check.repliesError && <p className="manage-state-error" role="status">回复：{commentErrors[check.repliesError]}</p>}
    {check.commentsError && <p className="manage-state-error" role="status">评论整轮：{commentErrors[check.commentsError]}</p>}
    {check.checkError && <p className="manage-state-error" role="status">检查：{errors[check.checkError]}</p>}
    {check.syncError && <p className="manage-state-error" role="status">同步：{errors[check.syncError]}</p>}
    </div>
  </section>;
}

/** 手动读取持久状态，不轮询，也不调用同步接口。 */
export function CheckStatusPanel({ uid, api, monitor }: { uid: string; api: ManagementApi; monitor: Monitor | null }) {
  const [checks, setChecks] = useState<readonly TargetCheck[] | null>(null);
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
