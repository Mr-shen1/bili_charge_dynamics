import type { DynamicReader } from '../../src/data/contracts';

/** 测试替身：只覆盖被测方法，其余读取路径显式报错而不是静默回退。 */
export function createReader(overrides: Partial<DynamicReader> = {}): DynamicReader {
  return {
    creator: { id: 'archive', nickname: '归档动态', avatarUrl: null },
    readUps: async () => ({ status: 'success', data: [] }),
    readList: async () => ({ status: 'error' }),
    readDetail: async () => ({ status: 'error' }),
    readComments: async () => ({ status: 'error' }),
    locateComment: async () => ({ status: 'not-found' }),
    readReplies: async () => ({ status: 'error' }),
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
