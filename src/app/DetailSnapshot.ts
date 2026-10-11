import type { Comment, CommentSort, ReadResult, Reply, Dynamic } from '../data/contracts';

import type { ReadingPosition } from './ListSnapshot';

export interface DiscussionReadState<T> {
  readonly status: ReadResult<{ items: readonly T[]; nextCursor: string | null }>['status'] | 'loading';
  readonly data: { readonly items: readonly T[]; readonly nextCursor: string | null } | null;
}
export interface ReplySnapshot {
  readonly read: DiscussionReadState<Reply>;
  readonly expanded: boolean;
  readonly expandedTexts: Readonly<Record<string, boolean>>;
}
export interface CommentSnapshot {
  readonly sort: CommentSort;
  readonly read: DiscussionReadState<Comment>;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly replies: Readonly<Record<string, ReplySnapshot>>;
}
export interface DetailSnapshot {
  readonly dynamic: Dynamic | null;
  readonly comments: CommentSnapshot;
  readonly position: ReadingPosition;
}
