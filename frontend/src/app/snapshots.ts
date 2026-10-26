import type {
  CommentBatch, CommentSort, Dynamic, DynamicBatch, LocateStatus, ReadResult, ReadStatus, ReplyBatch,
} from '../data/contracts';

/** 读取运行态只属于页面实例；进入访问快照的是上一次可见结果，不是进行中的请求。 */
export interface ListReadState {
  readonly data: DynamicBatch | null;
  readonly reason?: Extract<ReadResult<DynamicBatch>, { status: 'error' }>['reason'];
  readonly status: ReadStatus;
}

/**
 * 一级评论的已读批次与 cursor 进度；切换排序时整份重置。
 * `not-found` 只用于精确入口：目标不存在与暂时失败必须区分。
 */
export interface CommentReadState {
  readonly data: CommentBatch | null;
  readonly reason?: Extract<ReadResult<CommentBatch>, { status: 'error' }>['reason'];
  readonly status: LocateStatus;
}

/** 单个回复区的 cursor 预览结果；展开后的页码读取另有独立状态。 */
export interface ReplyReadState {
  readonly data: ReplyBatch | null;
  readonly reason?: Extract<ReadResult<ReplyBatch>, { status: 'error' }>['reason'];
  // `not-found` 只用于楼中楼精确入口：目标回复不存在与暂时失败必须区分。
  readonly status: LocateStatus;
}

/**
 * 回复区快照：预览结果、展开状态、保存页码与回复正文展开。
 * 页码只在展开时有意义，收起统一记回 1，再展开重读第 1 页。
 */
export interface ReplySnapshot {
  readonly read: ReplyReadState;
  readonly expanded: boolean;
  readonly page: number;
  readonly expandedTexts: Readonly<Record<string, boolean>>;
}

/** 恢复用的稳定锚点：优先按业务标识定位，缺失时才退回像素位置。 */
export interface ReadingPosition {
  readonly anchorId: string | null;
  readonly viewportOffset: number;
  readonly pixelY: number;
}

export interface ListSnapshot {
  readonly read: ListReadState;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly position: ReadingPosition | null;
}

export interface DetailSnapshot {
  readonly dynamic: Dynamic | null;
  readonly comments: CommentSnapshot;
  readonly position: ReadingPosition;
}

export interface CommentSnapshot {
  readonly sort: CommentSort;
  readonly read: CommentReadState;
  /** 一级评论正文展开状态；切换排序与重新开始读取时清空。 */
  readonly expanded: Readonly<Record<string, boolean>>;
  /** 按根评论 ID 保存的回复区状态；切换排序与重新开始读取时清空。 */
  readonly replies: Readonly<Record<string, ReplySnapshot>>;
}

/** 无会话新访问默认最热，与后端默认排序一致。 */
export function emptyCommentSnapshot(sort: CommentSort = 'hot'): CommentSnapshot {
  return { sort, read: { status: 'loading', data: null }, expanded: {}, replies: {} };
}
