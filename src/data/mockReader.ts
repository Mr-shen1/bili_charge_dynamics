import type { Dynamic, DynamicReader, User } from './contracts';

export interface MockDataset {
  readonly creator: User;
  readonly dynamics: readonly Dynamic[];
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

export function createMockReader(dataset: MockDataset): DynamicReader {
  const items = dataset.dynamics.map(item => ({
    ...item,
    author: normalizeUser(item.author),
    publishedAt: normalizeTime(item.publishedAt),
    commentCount: item.commentCount !== null && Number.isSafeInteger(item.commentCount) && item.commentCount >= 0
      ? item.commentCount : null,
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
    async readList({ limit, signal }) {
      if (signal.aborted) return { status: 'cancelled' };
      const size = Math.max(1, Math.min(10, Math.floor(limit)));
      return { status: 'success', data: {
        items: items.slice(0, size),
        // 本票只读取首批；调用方不解析标记，下一批能力归 02。
        nextCursor: items.length > size ? `dynamics:${size}` : null,
      } };
    },
    async readDetail({ id, signal }) {
      if (signal.aborted) return { status: 'cancelled' };
      const item = items.find(item => item.id === id);
      return item ? { status: 'success', data: item } : { status: 'not-found' };
    },
  };
}
