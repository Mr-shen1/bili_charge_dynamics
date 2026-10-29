import type { CommentSyncError } from './checkStatus';

/** 只展示封闭错误码的本地文案，绝不显示来源响应或异常原文。 */
export const commentSyncErrors: Readonly<Record<CommentSyncError, string>> = {
  ROOT_COMMENTS_FAILED: '根评论保存失败；已保存的动态保留，将在固定节拍重试。',
  REPLIES_FAILED: '回复保存失败；已保存的动态保留，将在固定节拍重试。',
  COMMENT_LOCATOR_UNCONFIRMED: '评论定位信息未确认；已保存的动态保留。',
};
