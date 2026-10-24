import { inject, type InjectionKey, type Plugin } from 'vue';
import type { DynamicReader } from '../data/contracts';

/**
 * 应用会话在根部创建、生命周期高于路由页面；页面只通过注入取得读取契约，
 * 不自行 new Adapter，也不共享模块级可变单例（测试各自创建独立实例）。
 */
export interface AppSession {
  readonly reader: DynamicReader;
}

const sessionKey: InjectionKey<AppSession> = Symbol('app-session');

export function createSessionPlugin(session: AppSession): Plugin {
  return {
    install(app) {
      app.provide(sessionKey, session);
    },
  };
}

export function useSession(): AppSession {
  const session = inject(sessionKey);
  if (!session) throw new Error('应用会话未装配');
  return session;
}
