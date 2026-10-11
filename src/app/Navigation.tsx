import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { ListSnapshot } from './ListSnapshot';
import type { DynamicImage } from '../data/contracts';
import { ImagePreview, type PreviewSession } from '../images/ImagePreview';
import { useLocation, useNavigate } from 'react-router';

interface PageEntry {
  readonly pageEntryId: string;
  readonly path: string;
  readonly sourcePageEntryId: string | null;
  readonly listSnapshot?: ListSnapshot;
  readonly detailTarget?: 'top' | 'comments';
}
interface Session {
  readonly sessionId: string;
  readonly entries: Readonly<Record<string, PageEntry>>;
  readonly previews: Readonly<Record<string, PreviewSession>>;
}
interface Navigation {
  readonly pageEntryId: string;
  readonly listSnapshot: ListSnapshot | undefined;
  readonly detailTarget: 'top' | 'comments';
  saveListSnapshot(pageEntryId: string, snapshot: ListSnapshot): void;
  openDetail(id: string, target?: 'top' | 'comments'): void;
  returnToList(): void;
  openImages(images: readonly DynamicImage[], index: number, trigger: HTMLElement): void;
}
const NavigationContext = createContext<Navigation | null>(null);

type SessionAction = { type: 'register'; entry: PageEntry }
  | { type: 'save-list'; pageEntryId: string; snapshot: ListSnapshot }
  | { type: 'open-preview'; preview: PreviewSession };

function reduceSession(state: Session, action: SessionAction): Session {
  if (action.type === 'open-preview') {
    return { ...state, previews: { ...state.previews, [action.preview.previewId]: action.preview } };
  }
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

function readMetadata(value: unknown): { sessionId: string; pageEntryId: string; previewId?: string } | null {
  if (typeof value !== 'object' || value === null || !('sessionId' in value) || !('pageEntryId' in value)) return null;
  return typeof value.sessionId === 'string' && typeof value.pageEntryId === 'string'
    ? { sessionId: value.sessionId, pageEntryId: value.pageEntryId,
      previewId: 'previewId' in value && typeof value.previewId === 'string' ? value.previewId : undefined } : null;
}

// 稳定挂载于所有路由页之上；访问元数据和列表快照仅保存在当前会话内存。
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, dispatch] = useReducer(reduceSession, undefined, () => ({
    sessionId: crypto.randomUUID(), entries: {}, previews: {},
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
  const candidatePreview = metadata?.previewId ? session.previews[metadata.previewId] : undefined;
  const preview = validEntry && candidatePreview?.pageEntryId === validEntry.pageEntryId ? candidatePreview : undefined;
  const closingKey = useRef<string | null>(null);
  // 去重只约束正在撤销的那次访问；离开记录后清除，不能永久禁止同一历史记录再次关闭。
  useLayoutEffect(() => { closingKey.current = null; }, [location.key]);
  const closePreview = useCallback(() => {
    // 只撤销本会话登记且指向当前底层访问的记录；重复关闭不重复后退。
    if (!preview || closingKey.current === location.key) return;
    closingKey.current = location.key;
    void navigate(-1);
  }, [preview, location.key, navigate]);

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
    detailTarget: entry.detailTarget ?? 'top',
    saveListSnapshot,
    openImages(images, index, trigger) {
      if (!validEntry || preview || !images[index]) return;
      const next: PreviewSession = { previewId: crypto.randomUUID(), pageEntryId: validEntry.pageEntryId,
        images, initialIndex: index, triggerId: trigger.id };
      dispatch({ type: 'open-preview', preview: next });
      void navigate(location.pathname + location.search + location.hash, {
        state: { sessionId: session.sessionId, pageEntryId: validEntry.pageEntryId, previewId: next.previewId },
      });
    },
    openDetail(id, target = 'top') {
      const next: PageEntry = {
        pageEntryId: crypto.randomUUID(), path: `/dynamics/${encodeURIComponent(id)}`, detailTarget: target,
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
  }), [entry.pageEntryId, entry.listSnapshot, entry.detailTarget, saveListSnapshot, validEntry, session.entries, session.sessionId, navigate, preview, location.pathname, location.search, location.hash]);
  return <NavigationContext.Provider value={navigation}>
    <div inert={!!preview}>{children}</div>
    {preview && <ImagePreview key={preview.previewId} preview={preview} close={closePreview} />}
  </NavigationContext.Provider>;
}

export function useAppNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error('SessionProvider is required');
  return navigation;
}
