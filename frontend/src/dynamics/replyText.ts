// B站回复正文自带“回复 @某人:”前缀；界面已单独表达目标，渲染前去掉这层重复。
const REPLY_PREFIX = /^回复\s*[@＠][^:：]{1,60}[:：]\s*/u;

export function replyBodyText(text: string): string {
  return text.replace(REPLY_PREFIX, '');
}

/**
 * 回复行要表达的目标：只有嵌套回复（父级不是本楼根评论）且目标昵称可用时显示，
 * 直接回根不重复。窄屏 UP 摘要另按来源给的 `replyTo` 判断（见 `ReplyPreview.vue`）。
 */
export function replyTargetNickname(
  reply: { readonly parentId?: string | null; readonly replyTo: { readonly nickname: string | null } | null },
  rootId: string,
): string | null {
  if (!reply.parentId || reply.parentId === rootId) return null;
  return reply.replyTo?.nickname ?? null;
}
