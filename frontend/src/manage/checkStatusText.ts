import type { ArchiveWorkState } from '../data/contracts';
import type { CheckError, CommentSyncError, MediaSyncError, TargetCheck } from '../data/checkStatus';
import { commentSyncErrors } from '../data/commentSyncErrors';
import type { CommentProgress } from '../data/commentProgress';
import { displayTime } from '../dynamics/display';

/** 检查折叠头的徽标只给短语，完整语义在展开后的正文里。 */
export const checkStatusBadgeText: Readonly<Record<TargetCheck['checkStatus'], string>> = {
  unchecked: '未检查', checked: '已检查', unchanged: '检查无变化', failed: '检查失败',
};
export const checkStatusBadgeType: Readonly<
Record<TargetCheck['checkStatus'], 'info' | 'success' | 'warning' | 'danger'>> = {
  unchecked: 'info', checked: 'success', unchanged: 'warning', failed: 'danger',
};
/** 检查无变化不等于同步成功，未检查也只是没有工作。 */
export const checkStatusText: Readonly<Record<TargetCheck['checkStatus'], string>> = {
  unchecked: '未检查',
  checked: '已检查，已登记观察。',
  unchanged: '检查无变化；不代表同步完成。',
  failed: '检查失败',
};
export const partText: Readonly<Record<ArchiveWorkState, string>> = {
  pending: '待处理', success: '已保存', restricted: '受限', failed: '失败',
};
export const attemptText: Readonly<Record<Exclude<TargetCheck['commentsLastAttempt'], null>, string>> = {
  pending: '待处理', success: '成功', failed: '失败', unconfirmed: '未确认',
};
export const commentProgressText: Readonly<Record<CommentProgress, string>> = {
  unchecked: '未检查', complete: '对应评论观察已完成', running: '同步中',
  'partial-failed': '部分完成', partial: '部分完成', failed: '失败，待重试',
  unconfirmed: '未确认', pending: '待处理',
};
export const checkErrorText: Readonly<Record<CheckError, string>> = {
  SOURCE_UNAVAILABLE: '来源暂不可用。',
  SIGNAL_INVALID: '编辑信号解析失败；保留已有可信值。',
  SYNC_INCOMPLETE: '同步未全部完成，将在固定节拍重试。',
};
export const mediaErrorText: Readonly<Record<MediaSyncError, string>> = {
  MEDIA_DOWNLOAD_FAILED: '图片下载失败；已保存内容保留，将在固定节拍重试。',
  MEDIA_UPLOAD_FAILED: '图片上传失败；已保存内容保留，将在固定节拍重试。',
};
/** 评论分项错误只用数据层已核验的封闭码文案，不显示来源响应或异常原文。 */
export const commentErrorText: Readonly<Record<CommentSyncError, string>> = commentSyncErrors;

interface LastTimes {
  readonly lastCheckedAt: string | null;
  readonly lastSucceededAt: string | null;
}

/**
 * UP 级时间：未读取时用身份读取带回的配置值；读取后改用刚读到的目标记录最大值，
 * 避免旧值在新记录旁边冒充当前最新状态。两者语义都是“历史目标记录的最近时间”。
 */
export function panelCheckTimes(
  monitor: LastTimes | null,
  checks: readonly TargetCheck[] | null,
): { readonly checked: string; readonly succeeded: string } {
  if (checks === null) {
    return {
      checked: monitor?.lastCheckedAt ? displayTime(monitor.lastCheckedAt) : '未检查',
      succeeded: monitor?.lastSucceededAt ? displayTime(monitor.lastSucceededAt) : '尚未成功',
    };
  }
  const latest = (pick: (check: TargetCheck) => string | null) => checks
    .map(pick)
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const checked = latest(check => check.lastCheckedAt);
  const succeeded = latest(check => check.lastSucceededAt);
  return {
    checked: checked ? displayTime(checked) : '未检查',
    succeeded: succeeded ? displayTime(succeeded) : '尚未成功',
  };
}
