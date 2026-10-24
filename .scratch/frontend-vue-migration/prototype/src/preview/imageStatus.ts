import type { ImageStatus } from '../demo/fixtures';

// 状态文案只在连接层维护一份，缩略图与预览共用，避免两处漂移。
export function statusMessage(status: ImageStatus): string {
  if (status === 'pending') return '图片待归档';
  if (status === 'failed') return '图片归档失败';
  if (status === 'invalid') return '归档图片地址不可用';
  return '图片加载失败';
}

/** 只有浏览器加载失败可局部重试；未上传/归档失败/无效地址不伪装成可重新采集。 */
export function isRetryable(status: ImageStatus): boolean {
  return status === 'ready' || status === 'broken' || status === 'flaky';
}

export function thumbnailPlaceholder(status: ImageStatus): string {
  return status === 'pending' || status === 'failed' ? statusMessage(status) : '无可用图片地址';
}
