import type { TargetCheck } from './checkStatus';

export interface User {
  readonly id: string;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
}

export interface ImageOwner {
  readonly type: 'dynamic' | 'comment';
  readonly id: string;
}

export interface DynamicImage {
  readonly id: string;
  readonly thumbnailUrl: string | null;
  readonly previewUrl: string | null;
  // 演示图无归档状态；生产图始终保留逐图上传状态，不以来源 URL 补空。
  readonly archiveStatus?: 'pending' | 'success' | 'failed';
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
  // 最新持久检查状态；旧冻结归档缺字段时不猜测执行时间或同步中。
  readonly commentSync?: TargetCheck | null;
  readonly title: string | null;
  readonly editedAt: string | null;
  readonly editStatus: 'observed' | 'unknown' | 'error';
  readonly contentState: 'success' | 'restricted' | 'failed';
  readonly lastAttempt: 'success' | 'restricted' | 'failed';
  readonly localCommentCount: number;
  readonly localReplyCount?: number | null;
  readonly rootCommentsLastAttempt?: 'pending' | 'success' | 'failed' | 'unconfirmed';
  readonly commentsLastAttempt?: 'pending' | 'success' | 'failed' | 'unconfirmed';
  readonly repliesLastAttempt?: 'pending' | 'success' | 'failed' | 'unconfirmed';
  readonly syncedCommentCount?: number | null;
  readonly syncedReplyCommentCount?: number | null;
  readonly mediaSources: readonly { readonly url: string; readonly width: number | null; readonly height: number | null }[];
  readonly commentLocator: Readonly<Record<string, unknown>> | null;
  readonly observedVersion: string | null;
  readonly syncedVersion: string | null;
  readonly work: { readonly text: ArchiveWorkState; readonly media: ArchiveWorkState; readonly comments: ArchiveWorkState; readonly replies?: 'pending' | 'success' };
}

export type CommentSort = 'hot' | 'latest';

export interface Comment {
  readonly id: string;
  readonly isPinned?: boolean;
  readonly author: User;
  readonly publishedAt: string | null;
  readonly text: string;
  readonly likeCount: number | null;
  readonly replyCount: number | null;
  // 作者在该楼中的最早一条回复，用于手机端楼中楼预览；作者未参与时为 null 或缺失。
  readonly upReply?: Reply | null;
  // 有序当前图片；未提供等价空集合，旧来源存在性由 pendingMediaCount 单独保留。
  readonly images?: readonly DynamicImage[];
  // 兼容旧评论的来源待归档数：只计尚无当前关联的位置，不计 images 中的 pending/failed。
  readonly pendingMediaCount?: number;
}

export const replyPreviewSize = 3;
export const replyAppendSize = 10;

export interface Reply extends Omit<Comment, 'isPinned' | 'replyCount' | 'pendingMediaCount' | 'images' | 'upReply'> {
  readonly replyTo: User | null;
  // 被回复对象的 ID；等于所属根评论时表示直接回根，不显示“回复 X”。
  readonly parentId?: string | null;
}

export interface ReplyBatch {
  readonly items: readonly Reply[];
  readonly nextCursor: string | null;
  // page 模式当前根的本地回复总数。
  readonly count?: number;
  // 楼中楼详情页的根评论：cursor 模式仅首批，page 模式每页返回。
  readonly root?: Comment | null;
  readonly sourceReplyCount?: number | null;
  readonly localReplyCount?: number | null;
  readonly repliesLastAttempt?: 'pending' | 'success' | 'failed' | 'unconfirmed';
  readonly syncedSourceReplyCount?: number | null;
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

/** 读取区域的公开状态；与传输无关，各读取状态、快照与提示共用一份字面量。 */
export type ReadStatus = 'loading' | 'success' | 'error' | 'cancelled';

/**
 * 精确入口额外区分“目标不存在”：它有自己的提示与返回入口，不交给通用失败提示。
 * 普通分页读取不会产生这个状态，所以详情/评论/回复的精确定位结果单独表达。
 */
export type LocateStatus = ReadStatus | 'not-found';

export type DetailResult = ReadResult<Dynamic> | { readonly status: 'not-found' };

/**
 * 精确评论入口的读取结果：不存在与暂时失败分开，成功批次以目标评论开头。
 * 不存在不当作读取失败，也不能用列表顶部冒充定位成功。
 */
export type CommentLocationResult = ReadResult<CommentBatch> | { readonly status: 'not-found' };

/**
 * 楼中楼精确入口的读取结果：`page` 是目标回复所在页码（1 起）。
 * 不存在不当作读取失败，也不能用楼层第一页冒充定位成功。
 */
export interface ReplyLocation extends ReplyBatch {
  readonly page: number;
}

export type ReplyLocationResult = ReadResult<ReplyLocation> | { readonly status: 'not-found' };

export interface DynamicReader {
  readonly creator: User;
  readonly discussions?: 'not-archived';
  readonly replies?: 'not-archived';
  readReplies(input: { readonly dynamicId: string; readonly rootId: string; readonly limit: number; readonly page?: number; readonly cursor?: string | null; readonly signal: AbortSignal }): Promise<ReadResult<ReplyBatch>>;
  readUps(input: { readonly signal: AbortSignal }): Promise<ReadResult<readonly User[]>>;
  readList(input: { readonly scope: ArchiveScope; readonly limit: number; readonly cursor?: string | null; readonly signal: AbortSignal }): Promise<ReadResult<DynamicBatch>>;
  readDetail(input: { readonly id: string; readonly signal: AbortSignal }): Promise<DetailResult>;
  readComments(input: { readonly dynamicId: string; readonly sort: CommentSort; readonly cursor?: string | null; readonly signal: AbortSignal }): Promise<ReadResult<CommentBatch>>;
  // 以动态与目标一级评论身份定位：只读归档，返回含目标的批次与续读游标。
  locateComment(input: { readonly dynamicId: string; readonly rootId: string; readonly sort: CommentSort; readonly signal: AbortSignal }): Promise<CommentLocationResult>;
  // 以动态、根评论与目标回复身份定位：只读归档，返回目标所在页。
  locateReply(input: { readonly dynamicId: string; readonly rootId: string; readonly replyId: string; readonly signal: AbortSignal }): Promise<ReplyLocationResult>;
}
