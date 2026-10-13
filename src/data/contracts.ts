export interface User {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
}

export interface DynamicImage {
  readonly id: string;
  readonly thumbnailUrl: string;
  readonly previewUrl: string;
  readonly width: number | null;
  readonly height: number | null;
}

// 图片数组表达读取层给定的顺序；未提供图片等价于空集合。
export interface Dynamic {
  readonly id: string;
  readonly author: User;
  readonly publishedAt: string | null;
  readonly text: string;
  readonly commentCount: number | null;
  readonly images?: readonly DynamicImage[];
  readonly archive?: ArchiveMetadata;
}

export type ArchiveWorkState = 'pending' | 'success' | 'restricted' | 'failed';

export interface ArchiveMetadata {
  readonly title: string | null;
  readonly editedAt: string | null;
  readonly editStatus: 'observed' | 'unknown' | 'error';
  readonly contentState: 'success' | 'restricted' | 'failed';
  readonly lastAttempt: 'success' | 'restricted' | 'failed';
  readonly localCommentCount: number;
  readonly mediaSources: readonly { readonly url: string; readonly width: number | null; readonly height: number | null }[];
  readonly commentLocator: Readonly<Record<string, unknown>> | null;
  readonly observedVersion: string | null;
  readonly syncedVersion: string | null;
  readonly work: { readonly text: ArchiveWorkState; readonly media: ArchiveWorkState; readonly comments: ArchiveWorkState };
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

export type ArchiveScope = { readonly kind: 'all' } | { readonly kind: 'up'; readonly upId: string };

export type ReadResult<T> =
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly reason?: 'not-archived' | 'unknown-up' | 'invalid-cursor' }
  | { readonly status: 'cancelled' };

export type DetailResult = ReadResult<Dynamic> | { readonly status: 'not-found' };

export interface DynamicReader {
  readonly creator: User;
  readonly discussions?: 'not-archived';
  readReplies(input: { readonly dynamicId: string; readonly rootId: string; readonly limit: number; readonly cursor?: string | null; readonly signal: AbortSignal }): Promise<ReadResult<ReplyBatch>>;
  readUps(input: { readonly signal: AbortSignal }): Promise<ReadResult<readonly User[]>>;
  readList(input: { readonly scope: ArchiveScope; readonly limit: number; readonly cursor?: string | null; readonly signal: AbortSignal }): Promise<ReadResult<DynamicBatch>>;
  readDetail(input: { readonly id: string; readonly signal: AbortSignal }): Promise<DetailResult>;
  readComments(input: { readonly dynamicId: string; readonly sort: CommentSort; readonly cursor?: string | null; readonly signal: AbortSignal }): Promise<ReadResult<CommentBatch>>;
}
