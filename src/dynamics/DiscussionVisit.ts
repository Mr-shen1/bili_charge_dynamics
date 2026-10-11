import { createContext, useContext, type RefObject } from 'react';
import type { CommentSnapshot } from '../app/DetailSnapshot';

// 属于单次详情访问的提交后草稿；卸载时交给会话，绝不修改已保存快照。
export const DiscussionVisitContext = createContext<RefObject<CommentSnapshot> | null>(null);
export function useDiscussionVisit() {
  const visit = useContext(DiscussionVisitContext);
  if (!visit) throw new Error('DiscussionVisitContext is required');
  return visit;
}
