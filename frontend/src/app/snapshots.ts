import type { Dynamic, DynamicBatch, ReadResult } from '../data/contracts';

/** 读取运行态只属于页面实例；进入访问快照的是上一次可见结果，不是进行中的请求。 */
export interface ListReadState {
  readonly data: DynamicBatch | null;
  readonly reason?: Extract<ReadResult<DynamicBatch>, { status: 'error' }>['reason'];
  readonly status: 'loading' | 'success' | 'error' | 'cancelled';
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
  readonly position: ReadingPosition;
}
