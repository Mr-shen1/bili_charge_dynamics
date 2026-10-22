// B站回复正文自带“回复 @某人:”前缀；界面已单独表达目标，渲染前去掉这层重复。
const REPLY_PREFIX = /^回复\s*[@＠][^:：]{1,60}[:：]\s*/u;

export function replyBodyText(text: string): string {
  return text.replace(REPLY_PREFIX, '');
}
