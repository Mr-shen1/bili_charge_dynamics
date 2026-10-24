import type { ImageStatus } from './types';

// 状态文案只在连接层维护一份，缩略图与预览共用，避免两处漂移。
export function statusMessage(status: ImageStatus): string {
  if (status === 'pending') return '图片待归档';
  if (status === 'failed') return '图片归档失败';
  if (status === 'invalid') return '归档图片地址不可用';
  return '图片加载失败';
}

/** 只有浏览器加载失败可局部重试；未上传/归档失败/无效地址不伪装成可重新采集。 */
export function isRetryable(status: ImageStatus): boolean {
  return status === 'ready' || status === 'broken';
}

export function thumbnailPlaceholder(status: ImageStatus): string {
  // 浏览器加载失败（ready/broken 在运行期失败）与无公开地址的归档状态分开表达。
  return unavailableReason(status) ?? '图片加载失败';
}

/** 无公开地址的归档状态文案；浏览器加载失败与可用图片返回 null。 */
export function unavailableReason(status: ImageStatus): string | null {
  return status === 'pending' || status === 'failed' || status === 'invalid' ? statusMessage(status) : null;
}
