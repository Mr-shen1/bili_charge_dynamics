import type { DetailResult, DynamicReader, DynamicBatch, ReadResult } from '../data/contracts';

interface Step<T> {
  readonly result?: T | Promise<T>;
  readonly delayMs?: number;
  readonly ignoreAbort?: boolean;
}
export interface ReadPlan {
  readonly list?: readonly Step<ReadResult<DynamicBatch>>[];
  readonly detail?: Readonly<Record<string, readonly Step<DetailResult>[]>>;
  readonly eachDetail?: readonly Step<DetailResult>[];
}

// 仅供开发/测试装配。计划按操作消费，不随机失败，可故意忽略取消制造乱序。
export function createControlledReader(base: DynamicReader, plan: ReadPlan): DynamicReader {
  const list = [...(plan.list ?? [])];
  const details = new Map(Object.entries(plan.detail ?? {}).map(([id, steps]) => [id, [...steps]]));
  async function run<T extends { readonly status: string }>(
    step: Step<T> | undefined, signal: AbortSignal, fallback: () => Promise<T>,
  ): Promise<T | { status: 'cancelled' }> {
    if (!step) return fallback();
    if (!step.ignoreAbort && signal.aborted) return { status: 'cancelled' };
    if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
    const result = step.result ? await step.result : await fallback();
    return !step.ignoreAbort && signal.aborted ? { status: 'cancelled' } : result;
  }
  return {
    creator: base.creator,
    async readList(input) {
      // 严格模式的即时清理不消费计划步骤。
      await Promise.resolve();
      if (input.signal.aborted) return { status: 'cancelled' };
      return run(list.shift(), input.signal, () => base.readList(input));
    },
    async readDetail(input) {
      await Promise.resolve();
      if (input.signal.aborted) return { status: 'cancelled' };
      const steps = details.get(input.id) ?? [...(plan.eachDetail ?? [])];
      details.set(input.id, steps);
      return run(steps.shift(), input.signal, () => base.readDetail(input));
    },
  };
}
