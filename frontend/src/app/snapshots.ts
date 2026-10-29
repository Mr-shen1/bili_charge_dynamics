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
  /**
   * 卡片内联评论区的状态，按卡片动态 ID 保存；键存在即表示该卡片当前展开。
   * 旧快照没有这个字段时按“没有任何卡片展开”恢复，不伪造已读状态。
   */
  readonly comments?: Readonly<Record<string, CommentSnapshot>>;
  readonly position: ReadingPosition | null;
}

export interface DetailSnapshot {
  readonly dynamic: Dynamic | null;
  readonly comments: CommentSnapshot;
  readonly position: ReadingPosition;
}

export interface CommentSnapshot {
  /**
   * 区域身份：这份状态属于哪个一级评论区域。读取与交互状态按它隔离，
   * 多个区域（详情、列表卡片、后续多访问）共用一个快照容器时不能互相冒充。
   * 未标记表示调用方给新区域的首份状态，本身还不属于任何区域。
   */
  readonly regionId?: string;
  readonly sort: CommentSort;
  readonly read: CommentReadState;
  /** 一级评论正文展开状态；切换排序与重新开始读取时清空。 */
  readonly expanded: Readonly<Record<string, boolean>>;
  /** 按根评论 ID 保存的回复区状态；切换排序与重新开始读取时清空。 */
  readonly replies: Readonly<Record<string, ReplySnapshot>>;
}

/**
 * 无可恢复状态的新访问默认按时间（设计 §4）。
 * 服务端省略 sort 时的 hot 默认保持不变，前端始终显式传排序。
 */
export function emptyCommentSnapshot(sort: CommentSort = 'latest'): CommentSnapshot {
  return { sort, read: { status: 'loading', data: null }, expanded: {}, replies: {} };
}

/**
 * 只采纳属于本区域的状态：未标记的快照是调用方给新区域的初值，可以采纳；
 * 标记了别的区域时退回本区域的默认状态，绝不复用别的区域的排序、批次与展开状态。
 * 区域身份由调用方显式给出，不读 DOM id，也不依赖唯一全局排序。
 */
export function adoptCommentSnapshot(
  snapshot: CommentSnapshot | undefined,
  regionId: string,
): CommentSnapshot {
  if (!snapshot) return emptyCommentSnapshot();
  if (snapshot.regionId !== undefined && snapshot.regionId !== regionId) return emptyCommentSnapshot();
  return snapshot;
}

/**
 * 列表卡片内联评论的区域身份：同一页面每张卡片一个区域，和详情区（`detail:`）互不冒充。
 * 身份由业务动态 ID 组成，不依赖 DOM id，也没有唯一的全局评论排序。
 */
export function listCommentRegionId(dynamicId: string): string {
  return `list:${dynamicId}`;
}

/**
 * 从列表访问快照取某张卡片的评论状态：只有标着该卡片区域的状态才算恢复。
 * 旧快照没有卡片评论字段、或存着别的区域状态时返回 `undefined`，按未展开处理。
 */
export function listCommentSnapshot(
  snapshot: ListSnapshot | undefined,
  dynamicId: string,
): CommentSnapshot | undefined {
  return listCommentSnapshots(snapshot)[dynamicId];
}

/**
 * 列表访问快照里属于卡片区域的全部评论状态，按动态 ID 索引。
 * 旧快照没有该字段时是空表；标着别的区域的状态被丢弃，不让详情区或别的卡片冒充。
 */
export function listCommentSnapshots(
  snapshot: ListSnapshot | undefined,
): Readonly<Record<string, CommentSnapshot>> {
  const regions = snapshot?.comments;
  if (!regions) return {};
  return Object.fromEntries(Object.entries(regions)
    .filter(([dynamicId, region]) => region.regionId === listCommentRegionId(dynamicId)));
}
