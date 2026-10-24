import type { DiscoveryState } from '../../src/manage/discoveryState';

/** 发现状态夹具：默认「已发布可信窗口」，其余状态由用例覆盖。 */
export function discoveryState(overrides: Partial<DiscoveryState> = {}): DiscoveryState {
  return {
    uid: '123',
    mode: 'recent',
    recentN: 2,
    enabled: true,
    active: true,
    status: 'discovered',
    attempt: {
      recentN: 2,
      startedAt: '2026-03-01T10:00:00+08:00',
      finishedAt: '2026-03-01T10:00:10+08:00',
      ids: ['1001'],
      error: null,
    },
    trustedResult: {
      recentN: 2,
      ids: ['1001', '1002'],
      exhausted: false,
      discoveredAt: '2026-03-01T10:00:10+08:00',
    },
    currentIds: ['1001', '1002'],
    retryable: false,
    incomplete: false,
    ...overrides,
  };
}
