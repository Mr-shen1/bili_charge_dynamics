export interface User {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
}

// 文字动态模型；图片在对应任务中扩展。
export interface Dynamic {
  readonly id: string;
  readonly author: User;
  readonly publishedAt: string | null;
  readonly text: string;
  readonly commentCount: number | null;
}

export type CommentSort = 'hot' | 'latest';

export interface Comment {
  readonly id: string;
  readonly author: User;
  readonly publishedAt: string | null;
  readonly text: string;
  readonly likeCount: number | null;
  readonly replyCount: number | null;
}

export const replyPreviewSize = 3;
export const replyAppendSize = 10;

export interface Reply extends Omit<Comment, 'replyCount'> {
  readonly replyTo: User | null;
}

export interface ReplyBatch {
  readonly items: readonly Reply[];
  readonly nextCursor: string | null;
}

export interface CommentBatch {
  readonly items: readonly Comment[];
  readonly nextCursor: string | null;
}

export interface DynamicBatch {
  readonly items: readonly Dynamic[];
  readonly nextCursor: string | null;
}

export type ReadResult<T> =
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error' }
  | { readonly status: 'cancelled' };

export type DetailResult = ReadResult<Dynamic> | { readonly status: 'not-found' };

export interface DynamicReader {
  readonly creator: User;
  readReplies(input: { readonly dynamicId: string; readonly rootId: string; readonly limit: number; readonly cursor?: string | null; readonly signal: AbortSignal }): Promise<ReadResult<ReplyBatch>>;
  readList(input: { readonly limit: number; readonly cursor?: string | null; readonly signal: AbortSignal }): Promise<ReadResult<DynamicBatch>>;
  readDetail(input: { readonly id: string; readonly signal: AbortSignal }): Promise<DetailResult>;
  readComments(input: { readonly dynamicId: string; readonly sort: CommentSort; readonly cursor?: string | null; readonly signal: AbortSignal }): Promise<ReadResult<CommentBatch>>;
}
