import { computed, inject, onUnmounted, provide, shallowRef, watch, type ComputedRef, type InjectionKey } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  appHistoryState, readEntryMarker, readPreviewMarker, type EntryMarker, type MarkerRead, type PreviewMarker,
} from './historyState';
import { createUuid } from './ids';
import type { DetailSnapshot, ListSnapshot } from './snapshots';

interface PageEntry {
  readonly pageEntryId: string;
  readonly path: string;
  readonly sourcePageEntryId: string | null;
  readonly detailTarget?: 'top' | 'comments';
  readonly listSnapshot?: ListSnapshot;
  readonly detailSnapshot?: DetailSnapshot;
}

export interface ArchiveNavigation {
  /** 当前历史记录的访问标识；同一地址的多次访问各有独立快照。 */
  readonly pageEntryId: string;
  readonly listSnapshot: ListSnapshot | undefined;
  readonly detailSnapshot: DetailSnapshot | undefined;
  /** 本次访问的主动入口目标；历史恢复（有快照）不使用它。 */
  readonly detailTarget: 'top' | 'comments';
  readonly sessionId: string;
  /** 历史记录中的预览标记（形状有效即可，会话/组大小由预览协调器校验）。 */
  readonly previewMarker: PreviewMarker | null;
  /** 含“存在但损坏”的命名空间读取，供预览协调器清理失效标记。 */
  readonly previewState: ComputedRef<MarkerRead<PreviewMarker>>;
  saveListSnapshot(pageEntryId: string, snapshot: ListSnapshot): void;
  saveDetailSnapshot(pageEntryId: string, snapshot: DetailSnapshot): void;
  openDetail(id: string, target?: 'top' | 'comments'): void;
  /** 从一级评论的 UP 摘要/数量入口进入独立楼中楼页。 */
  openThread(dynamicId: string, rootId: string): void;
  /** 退出楼中楼：有有效详情来源时真实后退，否则替换为对应动态详情。 */
  returnFromThread(dynamicId: string): void;
  /** 放弃不可用的精确定位入口，替换为对应动态详情；当前访问不会留下定位记录。 */
  showDetail(dynamicId: string): void;
  returnToList(): void;
  openPreview(marker: Omit<PreviewMarker, 'sessionId'>): Promise<void>;
  replacePreview(marker: Omit<PreviewMarker, 'sessionId'> | null): Promise<void>;
  back(): void;
}

const navigationKey: InjectionKey<ArchiveNavigation> = Symbol('archive-navigation');

// 导航结果由标记状态解释；这里只吸收框架抛出的取消/重复导航对象。
function ignoreNavigationFailure(navigation: Promise<unknown>): Promise<void> {
  return navigation.then(() => undefined, () => undefined);
}

function isListPath(path: string): boolean {
  return path === '/' || /^\/ups\/[^/]+$/.test(path);
}

/**
 * 详情族：普通详情与两个精确入口都是同一次动态/评论阅读，共用同一套快照与返回关系。
 * 精确入口只是这次阅读的主动定位入口，不是另一种页面；楼中楼不在详情族内。
 * 返回命中的动态 ID 段落，供返回关系核对同一动态。
 */
function detailFamily(path: string): string | null {
  const match = /^\/dynamics\/([^/]+)(?:\/comments\/[^/]+\/locate|\/comments\/[^/]+\/replies\/[^/]+\/locate)?$/.exec(path);
  return match ? match[1]! : null;
}

function isDetailPath(path: string): boolean {
  return detailFamily(path) !== null;
}

function isThreadPath(path: string): boolean {
  return /^\/dynamics\/[^/]+\/comments\/[^/]+$/.test(path);
}

/**
 * 唯一导航协调器：主动入口、历史返回、预览记录写入与位置恢复的会话身份都在这里。
 * 内容与快照保存在内存访问表中；历史记录只写轻量标识，不照搬框架内部 key。
 */
export function createArchiveNavigation(): ArchiveNavigation {
  const route = useRoute();
  const router = useRouter();
  const sessionId = createUuid();
  const ready = router.isReady().catch(() => undefined);
  const entries = shallowRef(new Map<string, PageEntry>());
  // 通过 Vue Router 自己的 history 读取状态：web history 与测试用的 memory history 都可用，
  // 历史记录自有的 back/current/forward/position 保持原样。
  const currentHistoryState = (): unknown => router.options.history.state;
  const historyState = shallowRef<unknown>(currentHistoryState());
  // 每次完成的导航推进一个代次：同一路径的新记录（如主题入口再回首页）必须得到新访问，
  // 不能沿用上一次同路径访问的快照与位置。这是保守的“新导航即新记录”判据，
  // 被取消的导航不会改变路由与状态，因此不会让已解析的兜底访问重新生成。
  let navigationEpoch = 0;
  const stopAfterEach = router.afterEach(() => {
    navigationEpoch += 1;
    historyState.value = currentHistoryState();
  });
  onUnmounted(() => { stopAfterEach(); });

  // 未登记的历史记录（首屏、刷新、外来导航）在读取时同步得到一次新访问，
  // 页面 setup 因此总能拿到稳定标识，不会先渲染旧访问再重建。
  let fresh: { path: string; epoch: number; entry: PageEntry } | null = null;

  function resolve(): PageEntry {
    const marker = readEntryMarker(historyState.value).marker;
    const known = marker?.sessionId === sessionId ? entries.value.get(marker.pageEntryId) : undefined;
    if (known && known.path === route.path) return known;
    if (!fresh || fresh.path !== route.path || fresh.epoch !== navigationEpoch) {
      fresh = {
        path: route.path,
        epoch: navigationEpoch,
        entry: { pageEntryId: createUuid(), path: route.path, sourcePageEntryId: null },
      };
    }
    return fresh.entry;
  }

  const current = computed(resolve);

  function register(entry: PageEntry): void {
    if (entries.value.has(entry.pageEntryId)) return;
    const next = new Map(entries.value);
    next.set(entry.pageEntryId, entry);
    entries.value = next;
  }

  function update(pageEntryId: string, patch: Partial<PageEntry>): void {
    const entry = entries.value.get(pageEntryId);
    if (!entry) return;
    const next = new Map(entries.value);
    next.set(pageEntryId, { ...entry, ...patch });
    entries.value = next;
  }

  function entryMarker(entry: PageEntry): EntryMarker {
    return { sessionId, pageEntryId: entry.pageEntryId };
  }

  function stateFor(entry: PageEntry, preview: PreviewMarker | null): ReturnType<typeof appHistoryState> {
    return appHistoryState({ entry: entryMarker(entry), preview });
  }

  const currentLocation = () => ({ path: route.path, query: route.query, hash: route.hash }) as const;

  let persistence: { pageEntryId: string; done: Promise<void> } | null = null;

  /**
   * 把访问标识补写进当前历史记录。首屏、刷新和外来导航没有标记，
   * 必须先落盘再打开预览或详情，否则返回时无法找回这次访问的快照。
   */
  function persist(entry: PageEntry): Promise<void> {
    const marker = readEntryMarker(currentHistoryState()).marker;
    if (marker?.sessionId === sessionId && marker.pageEntryId === entry.pageEntryId) return Promise.resolve();
    if (persistence?.pageEntryId === entry.pageEntryId) return persistence.done;
    const persisting = ready.then(() => {
      // 登记导航可能已被后续主动入口取代：只补写仍属于该访问的当前记录。
      if (current.value.pageEntryId !== entry.pageEntryId) return undefined;
      const latest = readEntryMarker(currentHistoryState()).marker;
      if (latest?.sessionId === sessionId && latest.pageEntryId === entry.pageEntryId) return undefined;
      return router.replace({
        ...currentLocation(), force: true,
        state: stateFor(entry, readPreviewMarker(currentHistoryState()).marker),
      });
    });
    const done = ignoreNavigationFailure(persisting);
    persistence = { pageEntryId: entry.pageEntryId, done };
    return done;
  }

  /** 等待可能仍在进行的补写，避免它把紧接着的返回或替换导航取消掉。 */
  function afterPendingPersistence(run: () => Promise<unknown> | void): Promise<void> {
    const entry = current.value;
    const pending = persistence?.pageEntryId === entry.pageEntryId ? persistence.done : Promise.resolve();
    return ignoreNavigationFailure(pending.then(() => {
      if (current.value.pageEntryId !== entry.pageEntryId) return undefined;
      return run();
    }));
  }

  /** 只有仍在原访问上时才执行主动入口，避免等待补写期间覆盖更新的导航。 */
  function afterPersist(entry: PageEntry, run: () => Promise<unknown> | void): Promise<void> {
    return ignoreNavigationFailure(persist(entry).then(() => {
      if (current.value.pageEntryId !== entry.pageEntryId) return undefined;
      return run();
    }));
  }

  watch(current, entry => {
    register(entry);
    void persist(entry);
  }, { immediate: true, flush: 'pre' });

  const previewState = computed(() => readPreviewMarker(historyState.value));

  function openDetail(id: string, target: 'top' | 'comments' = 'top'): void {
    const source = current.value;
    // 用路由自己解析的真实地址，含特殊字符的 ID 也不会与 route.path 失配。
    const entry: PageEntry = {
      pageEntryId: createUuid(),
      path: router.resolve({ name: 'detail', params: { dynamicId: id } }).path,
      // 来源关系仅在本模块从有效列表直接 PUSH 时建立；按地址初始化不会创建。
      sourcePageEntryId: isListPath(source.path) ? source.pageEntryId : null,
      detailTarget: target,
    };
    register(entry);
    void afterPersist(source, () => router.push({ path: entry.path, state: stateFor(entry, null) }));
  }

  function returnToList(): void {
    const entry = current.value;
    const source = entry.sourcePageEntryId ? entries.value.get(entry.sourcePageEntryId) : undefined;
    // 当前元数据已通过会话、登记记录和路径验证；该关系证明由列表直接 PUSH。
    if (source && isListPath(source.path) && isDetailPath(entry.path)) {
      void afterPendingPersistence(() => router.back());
      return;
    }
    // 无有效内存来源时替换为首页，绝不盲目离站。
    replaceWith('/');
  }

  /**
   * 进入独立楼中楼：只有当前记录确实是详情族访问（普通详情或精确入口）时才记来源关系，
   * 因此直达/刷新进入的楼中楼没有可后退的详情来源。
   */
  function openThread(dynamicId: string, rootId: string): void {
    const source = current.value;
    const entry: PageEntry = {
      pageEntryId: createUuid(),
      path: router.resolve({ name: 'thread', params: { dynamicId, rootId } }).path,
      sourcePageEntryId: isDetailPath(source.path) ? source.pageEntryId : null,
    };
    register(entry);
    void afterPersist(source, () => router.push({ path: entry.path, state: stateFor(entry, null) }));
  }

  /** 精确定位失败时的兜底入口：替换为动态详情，不把不可用地址留在历史里。 */
  function showDetail(dynamicId: string): void {
    replaceWith(router.resolve({ name: 'detail', params: { dynamicId } }).path);
  }

  function returnFromThread(dynamicId: string): void {
    const entry = current.value;
    const expected = router.resolve({ name: 'detail', params: { dynamicId } }).path;
    const source = entry.sourcePageEntryId ? entries.value.get(entry.sourcePageEntryId) : undefined;
    // 有有效详情来源（普通详情或精确入口访问）时真实后退，保留详情自己的快照、滚动与展开状态。
    if (source && isThreadPath(entry.path) && detailFamily(source.path) === detailFamily(expected)) {
      void afterPendingPersistence(() => router.back());
      return;
    }
    // 无来源（直达/刷新）时替换为对应动态详情，不在历史里留下楼中楼记录。
    replaceWith(expected);
  }

  function replaceWith(path: string): void {
    const entry: PageEntry = { pageEntryId: createUuid(), path, sourcePageEntryId: null };
    register(entry);
    void afterPendingPersistence(() => router.replace({ path, state: stateFor(entry, null) }));
  }

  function openPreview(marker: Omit<PreviewMarker, 'sessionId'>): Promise<void> {
    const entry = current.value;
    return afterPersist(entry, () => router.push({
      ...currentLocation(), force: true,
      state: stateFor(entry, { sessionId, ...marker }),
    }));
  }

  function replacePreview(marker: Omit<PreviewMarker, 'sessionId'> | null): Promise<void> {
    const entry = current.value;
    // 启动导航完成前写历史记录会被取消，导致损坏标记留在原记录上。
    return ignoreNavigationFailure(ready.then(() => {
      if (current.value.pageEntryId !== entry.pageEntryId) return undefined;
      return router.replace({
        ...currentLocation(), force: true,
        state: stateFor(entry, marker ? { sessionId, ...marker } : null),
      });
    }));
  }

  function back(): void {
    void afterPendingPersistence(() => router.go(-1));
  }

  function saveListSnapshot(pageEntryId: string, snapshot: ListSnapshot): void {
    const entry = entries.value.get(pageEntryId);
    if (!entry || !isListPath(entry.path)) return;
    update(pageEntryId, { listSnapshot: snapshot });
  }

  function saveDetailSnapshot(pageEntryId: string, snapshot: DetailSnapshot): void {
    const entry = entries.value.get(pageEntryId);
    // 精确入口与普通详情共用快照；楼中楼另有自己的读取规则，不保存详情快照。
    if (!entry || !isDetailPath(entry.path)) return;
    update(pageEntryId, { detailSnapshot: snapshot });
  }

  return {
    get pageEntryId() { return current.value.pageEntryId; },
    get listSnapshot() { return current.value.listSnapshot; },
    get detailSnapshot() { return current.value.detailSnapshot; },
    get detailTarget() { return current.value.detailTarget ?? 'top'; },
    get previewMarker() { return previewState.value.marker; },
    previewState,
    sessionId,
    saveListSnapshot,
    saveDetailSnapshot,
    openDetail,
    openThread,
    returnFromThread,
    showDetail,
    returnToList,
    openPreview,
    replacePreview,
    back,
  };
}

export function provideArchiveNavigation(navigation: ArchiveNavigation): void {
  provide(navigationKey, navigation);
}

export function useArchiveNavigation(): ArchiveNavigation {
  const navigation = inject(navigationKey);
  if (!navigation) throw new Error('归档导航协调器未装配');
  return navigation;
}
