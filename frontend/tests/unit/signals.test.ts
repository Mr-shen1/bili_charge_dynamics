import { describe, expect, it } from 'vitest';
import { combineSignals } from '../../src/app/signals';

// 目标设备含 iOS 16.4（票据 01 真机基线），Safari 17.4 才有 AbortSignal.any，
// 所以组合信号必须自带实现；这里只锁住行为，兼容性由 browser-baseline 守卫。
describe('combineSignals', () => {
  it('任一来源取消即取消组合信号', () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineSignals(first.signal, second.signal);
    expect(combined.aborted).toBe(false);
    second.abort();
    expect(combined.aborted).toBe(true);
  });

  it('来源已取消时立即取消，不再等待其他来源', () => {
    const aborted = new AbortController();
    aborted.abort();
    const combined = combineSignals(new AbortController().signal, aborted.signal);
    expect(combined.aborted).toBe(true);
  });

  it('没有来源被取消时不自行取消', () => {
    const combined = combineSignals(new AbortController().signal, new AbortController().signal);
    expect(combined.aborted).toBe(false);
  });

  it('组合信号取消后来源再取消不会抛错', () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineSignals(first.signal, second.signal);
    first.abort();
    expect(() => second.abort()).not.toThrow();
    expect(combined.aborted).toBe(true);
  });
});
