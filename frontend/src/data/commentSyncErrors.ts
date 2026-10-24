import type { CommentSyncError } from './checkStatus';

/** 只展示封闭错误码的本地文案，绝不显示来源响应或异常原文。 */
export const commentSyncErrors: Readonly<Record<CommentSyncError, string>> = {
  ROOT_COMMENTS_FAILED: '根评论归档失败；保留已有归档，将在固定节拍重试。',
  REPLIES_FAILED: '回复归档失败；保留已有归档，将在固定节拍重试。',
  COMMENT_LOCATOR_UNCONFIRMED: '评论定位信息未确认；保留已有归档。',
};
