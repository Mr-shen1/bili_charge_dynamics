import type {
  ManagedTarget, ManagedUp, ManagementApi, ManagementResult, NotificationState,
} from '../../src/manage/managementApi';
import type { TargetCheck } from '../../src/data/checkStatus';
import type { DiscoveryState } from '../../src/manage/discoveryState';

const failed = { status: 'error', message: '管理接口响应异常，请重试。' } as const;

/** 页面行为接缝的替身：默认所有操作都失败，被测用例只覆盖自己关心的路径。 */
export function createManagement(overrides: Partial<ManagementApi> = {}): ManagementApi {
  return {
    listUps: async (): Promise<ManagementResult<readonly ManagedUp[]>> => failed,
    addUp: async (): Promise<ManagementResult<ManagedUp>> => failed,
    updateMonitor: async (): Promise<ManagementResult<ManagedUp>> => failed,
    deleteMonitor: async (): Promise<ManagementResult<void>> => failed,
    listTargets: async (): Promise<ManagementResult<readonly ManagedTarget[]>> => failed,
    addTarget: async (): Promise<ManagementResult<ManagedTarget>> => failed,
    deleteTarget: async (): Promise<ManagementResult<void>> => failed,
    readDiscovery: async (): Promise<ManagementResult<DiscoveryState>> => failed,
    listChecks: async (): Promise<ManagementResult<readonly TargetCheck[]>> => failed,
    // 总开关在列表页顶部，与 UP 列表是两处独立读取：多数用例不以它为被测对象，
    // 默认给“运行中、无待发”，避免它的读取失败提示混进 UP 列表的断言。
    readNotification: async (): Promise<ManagementResult<NotificationState>> =>
      ({ status: 'success', data: { enabled: true, pending: 0 } }),
    updateNotification: async (): Promise<ManagementResult<NotificationState>> => failed,
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
