import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { ListSnapshot } from './ListSnapshot';
import type { DetailSnapshot } from './DetailSnapshot';
import type { DynamicImage } from '../data/contracts';
import { ImagePreview, type PreviewSession } from '../images/ImagePreview';
import { useLocation, useNavigate } from 'react-router';

interface PageEntry {
  readonly pageEntryId: string;
  readonly path: string;
  readonly sourcePageEntryId: string | null;
  readonly listSnapshot?: ListSnapshot;
  readonly detailSnapshot?: DetailSnapshot;
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
  readonly detailSnapshot: DetailSnapshot | undefined;
  readonly detailTarget: 'top' | 'comments';
  saveListSnapshot(pageEntryId: string, snapshot: ListSnapshot): void;
  saveDetailSnapshot(pageEntryId: string, snapshot: DetailSnapshot): void;
  openDetail(id: string, target?: 'top' | 'comments'): void;
  returnToList(): void;
  openImages(images: readonly DynamicImage[], index: number, trigger: HTMLElement): void;
}
const NavigationContext = createContext<Navigation | null>(null);

type SessionAction = { type: 'register'; entry: PageEntry }
  | { type: 'save-list'; pageEntryId: string; snapshot: ListSnapshot }
  | { type: 'save-detail'; pageEntryId: string; snapshot: DetailSnapshot }
  | { type: 'open-preview'; preview: PreviewSession }
  | { type: 'move-preview'; previewId: string; offset: number }
  | { type: 'preview-mode'; previewId: string; mode: PreviewSession['displayMode'] };

function reduceSession(state: Session, action: SessionAction): Session {
  if (action.type === 'open-preview') {
    return { ...state, previews: { ...state.previews, [action.preview.previewId]: action.preview } };
  }
  if (action.type === 'move-preview') {
    const preview = state.previews[action.previewId];
    if (!preview) return state;
    const index = Math.max(0, Math.min(preview.images.length - 1, preview.currentIndex + action.offset));
    if (preview.currentIndex === index) return state;
    return { ...state, previews: { ...state.previews,
      [action.previewId]: { ...preview, currentIndex: index },
    } };
  }
  if (action.type === 'preview-mode') {
    const preview = state.previews[action.previewId];
    if (!preview || preview.displayMode === action.mode) return state;
    return { ...state, previews: { ...state.previews,
      [action.previewId]: { ...preview, displayMode: action.mode },
    } };
  }
  if (action.type === 'register') {
    const entry = action.entry;
    if (state.entries[entry.pageEntryId]) return state;
    return { ...state, entries: { ...state.entries, [entry.pageEntryId]: entry } };
  }
  const entry = state.entries[action.pageEntryId];
  if (!entry) return state;
  if (action.type === 'save-detail') {
    if (!entry.path.startsWith('/dynamics/')) return state;
    return { ...state, entries: { ...state.entries,
      [action.pageEntryId]: { ...entry, detailSnapshot: action.snapshot },
    } };
  }
  if (entry.path !== '/') return state;
  return { ...state, entries: { ...state.entries,
    [action.pageEntryId]: { ...entry, listSnapshot: action.snapshot },
  } };
}

function readMetadata(value: unknown): { sessionId: string; pageEntryId: string; previewId?: string | null } | null {
  if (typeof value !== 'object' || value === null || !('sessionId' in value) || !('pageEntryId' in value)) return null;
  return typeof value.sessionId === 'string' && typeof value.pageEntryId === 'string'
    ? { sessionId: value.sessionId, pageEntryId: value.pageEntryId,
      // 区分“没有标记”与“标记形状损坏”，后者同样需要替换清理。
      previewId: 'previewId' in value ? (typeof value.previewId === 'string' ? value.previewId : null) : undefined } : null;
}

// 稳定挂载于所有路由页之上；访问元数据和阅读快照仅保存在当前会话内存。
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
  const previewId = preview?.previewId;
  const movePreviewImage = useCallback((id: string, offset: number) => {
    dispatch({ type: 'move-preview', previewId: id, offset });
  }, []);
  const changePreviewMode = useCallback((id: string, mode: PreviewSession['displayMode']) => {
    dispatch({ type: 'preview-mode', previewId: id, mode });
  }, []);
  const closingPreviewId = useRef<string | null>(null);
  // 仅离开预览后清除去重；同一预览 REPLACE 改 key 不得重启关闭，前进重进仍可关闭。
  useLayoutEffect(() => { closingPreviewId.current = null; }, [previewId]);
  const closePreview = useCallback(() => {
    // 只撤销本会话登记且指向当前底层访问的记录；重复关闭不重复后退。
    if (!previewId || closingPreviewId.current === previewId) return;
    closingPreviewId.current = previewId;
    void navigate(-1);
  }, [previewId, navigate]);

  useEffect(() => {
    if (validEntry) {
      if (metadata?.previewId !== undefined && !previewId) {
        // 仅预览引用失效：替换当前记录，沿用底层访问及其阅读快照，不猜测后退关系。
        void navigate(location.pathname + location.search + location.hash, {
          replace: true, state: { sessionId: session.sessionId, pageEntryId: validEntry.pageEntryId },
        });
      }
      return;
    }
    dispatch({ type: 'register', entry: freshEntry });
    // 首次 POP、失效会话或未登记的 PUSH/REPLACE 都按地址建新访问，不猜测来源。
    void navigate(location.pathname + location.search + location.hash, {
      replace: true, state: { sessionId: session.sessionId, pageEntryId: freshEntry.pageEntryId },
    });
  }, [validEntry, freshEntry, metadata?.previewId, previewId, location.pathname, location.search, location.hash, navigate, session.sessionId]);

  useEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => { window.history.scrollRestoration = previous; };
  }, []);

  const saveListSnapshot = useCallback((pageEntryId: string, snapshot: ListSnapshot) => {
    dispatch({ type: 'save-list', pageEntryId, snapshot });
  }, []);
  const saveDetailSnapshot = useCallback((pageEntryId: string, snapshot: DetailSnapshot) => {
    dispatch({ type: 'save-detail', pageEntryId, snapshot });
  }, []);
  const navigation = useMemo<Navigation>(() => ({
    pageEntryId: entry.pageEntryId,
    listSnapshot: entry.listSnapshot,
    detailSnapshot: entry.detailSnapshot,
    detailTarget: entry.detailTarget ?? 'top',
    saveListSnapshot,
    saveDetailSnapshot,
    openImages(images, index, trigger) {
      if (!validEntry || previewId || !images[index]) return;
      const next: PreviewSession = { previewId: crypto.randomUUID(), pageEntryId: validEntry.pageEntryId,
        images, currentIndex: index, displayMode: 'contain', triggerId: trigger.id };
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
  }), [entry.pageEntryId, entry.listSnapshot, entry.detailSnapshot, entry.detailTarget, saveListSnapshot, saveDetailSnapshot, validEntry, session.entries, session.sessionId, navigate, previewId, location.pathname, location.search, location.hash]);
  return <NavigationContext.Provider value={navigation}>
    <div inert={!!preview}>{children}</div>
    {preview && <ImagePreview key={preview.previewId} preview={preview} close={closePreview} moveImage={movePreviewImage} changeMode={changePreviewMode} />}
  </NavigationContext.Provider>;
}

export function useAppNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error('SessionProvider is required');
  return navigation;
}
