import type { ManagedUp, ManagementApi, ManagementResult } from '../../src/manage/managementApi';

const failed = { status: 'error', message: '管理接口响应异常，请重试。' } as const;

/** 页面行为接缝的替身：默认三个操作都失败，被测用例只覆盖自己关心的路径。 */
export function createManagement(overrides: Partial<ManagementApi> = {}): ManagementApi {
  return {
    listUps: async (): Promise<ManagementResult<readonly ManagedUp[]>> => failed,
    addUp: async (): Promise<ManagementResult<ManagedUp>> => failed,
    updateMonitor: async (): Promise<ManagementResult<ManagedUp>> => failed,
    ...overrides,
  };
}

/** 已映射的管理实体：页面测试不重复 snake_case，映射本身由 Adapter 契约测试覆盖。 */
export function managementUp(uid: string, overrides: Partial<ManagedUp> = {}): ManagedUp {
  return {
    uid,
    name: `用户 ${uid}`,
    avatarUrl: 'https://example.test/avatar.png',
    monitor: { mode: 'recent', recentN: 10, enabled: true, lastCheckedAt: null, lastSucceededAt: null },
    ...overrides,
  };
}
