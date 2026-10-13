import type { CommentBatch, CommentSort, ReadResult, ReplyBatch, Dynamic } from '../data/contracts';

import type { ReadingPosition } from './ListSnapshot';

export interface DiscussionReadState<Batch> {
  readonly status: ReadResult<Batch>['status'] | 'loading';
  readonly data: Batch | null;
  readonly reason?: Extract<ReadResult<never>, { status: 'error' }>['reason'];
}
export interface ReplySnapshot {
  readonly read: DiscussionReadState<ReplyBatch>;
  readonly expanded: boolean;
  readonly expandedTexts: Readonly<Record<string, boolean>>;
}
export interface CommentSnapshot {
  readonly sort: CommentSort;
  readonly read: DiscussionReadState<CommentBatch>;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly replies: Readonly<Record<string, ReplySnapshot>>;
}
export function emptyCommentSnapshot(sort: CommentSort = 'hot'): CommentSnapshot {
  return { sort, read: { status: 'loading', data: null }, expanded: {}, replies: {} };
}

export interface DetailSnapshot {
  readonly dynamic: Dynamic | null;
  readonly comments: CommentSnapshot;
  readonly position: ReadingPosition;
}
