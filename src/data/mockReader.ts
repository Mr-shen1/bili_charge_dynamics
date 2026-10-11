import { replyAppendSize, replyPreviewSize } from './contracts';
import type { Comment, Dynamic, DynamicReader, ReadResult, Reply, User } from './contracts';

export interface MockDataset {
  readonly creator: User;
  readonly dynamics: readonly Dynamic[];
  readonly comments?: Readonly<Record<string, readonly Comment[]>>;
  readonly replies?: Readonly<Record<string, Readonly<Record<string, readonly Reply[]>>>>;
}

function normalizeUser(user: User): User {
  return {
    id: user.id,
    nickname: user.nickname?.trim() ? user.nickname : null,
    avatarUrl: user.avatarUrl?.trim() ? user.avatarUrl : null,
  };
}

function normalizeTime(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  // Date.parse 会把 2 月 30 日等值滚入下月；必须先校验来源日历日期。
  const datePart = value.slice(0, 10);
  const calendar = new Date(`${datePart}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== datePart) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeCount(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readBatch<T>(
  items: readonly T[], prefix: string, cursor: string | null | undefined, size: number,
): ReadResult<{ readonly items: readonly T[]; readonly nextCursor: string | null }> {
  const offset = cursor == null ? 0 : cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) return { status: 'error' };
  return { status: 'success', data: {
    items: items.slice(offset, offset + size),
    nextCursor: items.length > offset + size ? `${prefix}${offset + size}` : null,
  } };
}

export function createMockReader(dataset: MockDataset): DynamicReader {
  const items = dataset.dynamics.map(item => ({
    ...item,
    author: normalizeUser(item.author),
    publishedAt: normalizeTime(item.publishedAt),
    commentCount: normalizeCount(item.commentCount),
  })).sort((a, b) => {
    if (a.publishedAt !== b.publishedAt) {
      if (a.publishedAt === null) return 1;
      if (b.publishedAt === null) return -1;
      return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return {
    creator: normalizeUser(dataset.creator),
    async readList({ limit, cursor, signal }) {
      if (signal.aborted) return { status: 'cancelled' };
      const prefix = `dynamics:${encodeURIComponent(dataset.creator.id)}:time-desc:`;
      const size = Number.isFinite(limit) ? Math.max(1, Math.min(10, Math.floor(limit))) : 10;
      return readBatch(items, prefix, cursor, size);
    },
    async readReplies({ dynamicId, rootId, limit, cursor, signal }) {
      if (signal.aborted) return { status: 'cancelled' };
      const prefix = `replies:${encodeURIComponent(dataset.creator.id)}:${encodeURIComponent(dynamicId)}:${encodeURIComponent(rootId)}:time-asc:`;
      const replies = (dataset.replies?.[dynamicId]?.[rootId] ?? []).map(item => ({
        ...item, author: normalizeUser(item.author), publishedAt: normalizeTime(item.publishedAt),
        likeCount: normalizeCount(item.likeCount),
        replyTo: item.replyTo ? normalizeUser(item.replyTo) : null,
      })).sort((a, b) => {
        if (a.publishedAt !== b.publishedAt) {
          if (a.publishedAt === null) return 1;
          if (b.publishedAt === null) return -1;
          return Date.parse(a.publishedAt) - Date.parse(b.publishedAt);
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const maximum = cursor == null ? replyPreviewSize : replyAppendSize;
      const size = Number.isFinite(limit) ? Math.max(1, Math.min(maximum, Math.floor(limit))) : maximum;
      return readBatch(replies, prefix, cursor, size);
    },
    async readComments({ dynamicId, sort, cursor, signal }) {
      if (signal.aborted) return { status: 'cancelled' };
      const prefix = `comments:${encodeURIComponent(dataset.creator.id)}:${encodeURIComponent(dynamicId)}:${sort}:`;
      const comments = (dataset.comments?.[dynamicId] ?? []).map(item => ({
        ...item, author: normalizeUser(item.author), publishedAt: normalizeTime(item.publishedAt),
        likeCount: normalizeCount(item.likeCount),
        replyCount: normalizeCount(item.replyCount),
      })).sort((a, b) => {
        if (sort === 'hot' && a.likeCount !== b.likeCount) {
          if (a.likeCount === null) return 1;
          if (b.likeCount === null) return -1;
          return b.likeCount - a.likeCount;
        }
        if (a.publishedAt !== b.publishedAt) {
          if (a.publishedAt === null) return 1;
          if (b.publishedAt === null) return -1;
          return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return readBatch(comments, prefix, cursor, 20);
    },
    async readDetail({ id, signal }) {
      if (signal.aborted) return { status: 'cancelled' };
      const item = items.find(item => item.id === id);
      return item ? { status: 'success', data: item } : { status: 'not-found' };
    },
  };
}
