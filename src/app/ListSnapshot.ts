import type { DynamicBatch, ReadResult } from '../data/contracts';

export interface ListReadState {
  readonly data: DynamicBatch | null;
  readonly reason?: Extract<ReadResult<DynamicBatch>, { status: 'error' }>['reason'];
  readonly status: 'loading' | 'success' | 'error' | 'cancelled';
}

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
