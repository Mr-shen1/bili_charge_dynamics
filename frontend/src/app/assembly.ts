// 装配隔离：默认真实 API；独立 mock 与开发故障装配只由显式 mode 启用。
export type AssemblyKind = 'production' | 'mock' | 'fault';

export interface AppAssembly {
  readonly kind: AssemblyKind;
  /** 只有 mock/fault 装配注册图片自检路由；生产构建不包含该页面与其夹具。 */
  readonly previewFixtures: boolean;
}

export function resolveAssemblyKind(mode: string): AssemblyKind {
  if (mode === 'mock') return 'mock';
  if (mode === 'fault') return 'fault';
  return 'production';
}

export function createAssembly(mode: string): AppAssembly {
  const kind = resolveAssemblyKind(mode);
  return { kind, previewFixtures: kind !== 'production' };
}

// mode 在构建期固定并由 Vite 替换为字面量：这里用常量表达式，
// 好让普通 build 能把 mock/fault 的路由与夹具代码整体摇掉。
export const appMode = import.meta.env.MODE;
/**
 * 必须是字面量比较：Rollup 才会把普通构建里的 mock/fault 分支与动态 import 摇掉。
 * 不要改成 includes()、数组查表或从 assembly 派生，否则生产包会重新带上自检页面。
 */
export const previewFixturesEnabled = appMode === 'mock' || appMode === 'fault';
export const assembly: AppAssembly = createAssembly(appMode);
