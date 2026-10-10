import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { ListSnapshot } from './ListSnapshot';
import { useLocation, useNavigate } from 'react-router';

interface PageEntry {
  readonly pageEntryId: string;
  readonly path: string;
  readonly sourcePageEntryId: string | null;
  readonly listSnapshot?: ListSnapshot;
}
interface Session {
  readonly sessionId: string;
  readonly entries: Readonly<Record<string, PageEntry>>;
}
interface Navigation {
  readonly pageEntryId: string;
  readonly listSnapshot: ListSnapshot | undefined;
  saveListSnapshot(pageEntryId: string, snapshot: ListSnapshot): void;
  openDetail(id: string): void;
  returnToList(): void;
}
const NavigationContext = createContext<Navigation | null>(null);

type SessionAction = { type: 'register'; entry: PageEntry }
  | { type: 'save-list'; pageEntryId: string; snapshot: ListSnapshot };

function reduceSession(state: Session, action: SessionAction): Session {
  if (action.type === 'register') {
    const entry = action.entry;
    if (state.entries[entry.pageEntryId]) return state;
    return { ...state, entries: { ...state.entries, [entry.pageEntryId]: entry } };
  }
  const entry = state.entries[action.pageEntryId];
  if (!entry || entry.path !== '/') return state;
  return { ...state, entries: { ...state.entries,
    [action.pageEntryId]: { ...entry, listSnapshot: action.snapshot },
  } };
}

function readMetadata(value: unknown): { sessionId: string; pageEntryId: string } | null {
  if (typeof value !== 'object' || value === null || !('sessionId' in value) || !('pageEntryId' in value)) return null;
  return typeof value.sessionId === 'string' && typeof value.pageEntryId === 'string'
    ? { sessionId: value.sessionId, pageEntryId: value.pageEntryId } : null;
}

// 稳定挂载于所有路由页之上；访问元数据和列表快照仅保存在当前会话内存。
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, dispatch] = useReducer(reduceSession, undefined, () => ({
    sessionId: crypto.randomUUID(), entries: {},
  }));
  const location = useLocation();
  const navigate = useNavigate();
  const metadata = readMetadata(location.state);
  const knownEntry = metadata?.sessionId === session.sessionId ? session.entries[metadata.pageEntryId] : undefined;
  const validEntry = knownEntry?.path === location.pathname ? knownEntry : undefined;
  const freshEntry = useMemo<PageEntry>(() => ({
    pageEntryId: crypto.randomUUID(), path: location.pathname, sourcePageEntryId: null,
  }), [location.key, location.pathname]);
  const entry = validEntry ?? freshEntry;

  useEffect(() => {
    if (validEntry) return;
    dispatch({ type: 'register', entry: freshEntry });
    // 首次 POP、失效会话或未登记的 PUSH/REPLACE 都按地址建新访问，不猜测来源。
    void navigate(location.pathname + location.search + location.hash, {
      replace: true, state: { sessionId: session.sessionId, pageEntryId: freshEntry.pageEntryId },
    });
  }, [validEntry, freshEntry, location.pathname, location.search, location.hash, navigate, session.sessionId]);

  useEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => { window.history.scrollRestoration = previous; };
  }, []);

  const saveListSnapshot = useCallback((pageEntryId: string, snapshot: ListSnapshot) => {
    dispatch({ type: 'save-list', pageEntryId, snapshot });
  }, []);
  const navigation = useMemo<Navigation>(() => ({
    pageEntryId: entry.pageEntryId,
    listSnapshot: entry.listSnapshot,
    saveListSnapshot,
    openDetail(id) {
      const next: PageEntry = {
        pageEntryId: crypto.randomUUID(), path: `/dynamics/${encodeURIComponent(id)}`,
        // 来源关系仅在本模块从有效列表直接 PUSH 时建立；按地址初始化不会创建。
        sourcePageEntryId: validEntry?.path === '/' ? validEntry.pageEntryId : null,
      };
      dispatch({ type: 'register', entry: next });
      void navigate(next.path, { state: { sessionId: session.sessionId, pageEntryId: next.pageEntryId } });
    },
    returnToList() {
      const source = validEntry?.sourcePageEntryId ? session.entries[validEntry.sourcePageEntryId] : undefined;
      // 当前元数据已通过会话、登记记录和路径验证；该关系证明由列表直接 PUSH。
      // 刷新/未知导航不在内存登记表中，不能仅凭 history.length 或外来 path 后退。
      if (source?.path === '/' && validEntry?.path.startsWith('/dynamics/')) {
        void navigate(-1);
      } else {
        // 无有效内存来源时替换为首页，绝不盲目离站。
        void navigate('/', { replace: true, state: null });
      }
    },
  }), [entry.pageEntryId, entry.listSnapshot, saveListSnapshot, validEntry, session.entries, session.sessionId, navigate]);
  return <NavigationContext.Provider value={navigation}>{children}</NavigationContext.Provider>;
}

export function useAppNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error('SessionProvider is required');
  return navigation;
}
