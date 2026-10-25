/**
 * 组合多个取消信号：任一来源取消即取消结果。
 *
 * 目标设备含 iOS 16.4（票据 01/15 的真机基线），而 `AbortSignal.any` 要 Safari 17.4 才有；
 * Vite 不 polyfill Web API，直接用它会在真机上同步抛错（票据 15 的 F-15-01）。
 * 这里只实现用得到的语义：不传取消原因，调用方只判断 `aborted`。
 */
export function combineSignals(...signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = (): void => {
    for (const signal of signals) signal.removeEventListener('abort', onAbort);
    controller.abort();
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}
