import type { ArchiveMetadata, ArchiveWorkState, Comment, CommentBatch, DetailResult, Dynamic, DynamicBatch, DynamicReader, ReadResult, User } from './contracts';
import { isValidId } from './identifiers';
import { isRecord as record } from './guards';

export type ArchiveTransport = (url: string, init: RequestInit) => Promise<Response>;
const failed = { status: 'error' } as const;
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function time(value: unknown, minute = false): string | null {
  const pattern = minute ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+08:00$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
  if (typeof value !== 'string' || !pattern.test(value)) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  // Date.parse 会把 2 月 30 日、24:00 等滚动到下一天，不能伪造有效来源时间。
  const precision = minute ? 16 : 19;
  return new Date(epoch + 8 * 3600_000).toISOString().slice(0, precision) === value.slice(0, precision) ? value : null;
}
function url(value: unknown, sourceOnly = false): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || sourceOnly && parsed.protocol === 'http:') && !parsed.username && !parsed.password ? value : null;
  } catch { return null; }
}
function contentState(value: unknown): value is ArchiveMetadata['contentState'] {
  return value === 'success' || value === 'restricted' || value === 'failed';
}
function editStatus(value: unknown): value is ArchiveMetadata['editStatus'] {
  return value === 'observed' || value === 'unknown' || value === 'error';
}
function workState(value: unknown): value is ArchiveWorkState {
  return value === 'pending' || value === 'success' || value === 'restricted' || value === 'failed';
}
function version(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
function parseArchive(raw: unknown): Dynamic | null {
  if (!record(raw) || !isValidId(raw.id) || !record(raw.author) || !isValidId(raw.author.id)
    || typeof raw.text !== 'string' || !contentState(raw.content_state) || !contentState(raw.last_attempt)
    || !editStatus(raw.edit_status)
    || count(raw.local_comment_count) === null || !Array.isArray(raw.media_sources)
    || !(raw.comment_locator === null || record(raw.comment_locator))
    || !version(raw.observed_version) || !version(raw.synced_version)
    || !record(raw.work) || !workState(raw.work.text)
    || !workState(raw.work.media) || !workState(raw.work.comments)) return null;
  const mediaSources: ArchiveMetadata['mediaSources'][number][] = [];
  for (const source of raw.media_sources) {
    if (!record(source)) return null;
    const sourceUrl = url(source.url, true);
    if (!sourceUrl) return null;
    mediaSources.push({ url: sourceUrl, width: count(source.width) || null, height: count(source.height) || null });
  }
  const status = raw.edit_status;
  return {
    id: raw.id,
    author: { id: raw.author.id, nickname: typeof raw.author.nickname === 'string' && raw.author.nickname.trim() ? raw.author.nickname : null,
      avatarUrl: url(raw.author.avatar_url) },
    publishedAt: time(raw.published_at), text: raw.text, commentCount: count(raw.source_comment_count), images: [],
    archive: { title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : null,
      editedAt: time(raw.edited_at, true), editStatus: status, contentState: raw.content_state,
      lastAttempt: raw.last_attempt, localCommentCount: Number(raw.local_comment_count),
      localReplyCount: count(raw.local_reply_count),
      rootCommentsLastAttempt: raw.root_comments_last_attempt === 'pending' || raw.root_comments_last_attempt === 'success'
        || raw.root_comments_last_attempt === 'failed' || raw.root_comments_last_attempt === 'unconfirmed' ? raw.root_comments_last_attempt : undefined,
      mediaSources,
      commentLocator: raw.comment_locator, observedVersion: raw.observed_version, syncedVersion: raw.synced_version,
      work: { text: raw.work.text, media: raw.work.media, comments: raw.work.comments } },
  };
}

function parseComment(raw: unknown, dynamicId: string): Comment | null {
  if (!record(raw) || !isValidId(raw.id) || raw.dynamic_id !== dynamicId
    || raw.root_id !== '0' || raw.parent_id !== '0' || !record(raw.author)
    || !(raw.author.id === null || isValidId(raw.author.id))
    || !version(raw.author.nickname) || !version(raw.author.avatar_url)
    || !version(raw.text) || !version(raw.published_at)
    || !(raw.like_count === null || count(raw.like_count) !== null)
    || !(raw.source_reply_count === null || count(raw.source_reply_count) !== null)
    || !(raw.comment_locator === null || record(raw.comment_locator)) || !Array.isArray(raw.media_sources)) return null;
  for (const source of raw.media_sources) {
    if (!record(source) || typeof source.url !== 'string'
      || !(source.width === null || count(source.width) !== null)
      || !(source.height === null || count(source.height) !== null)) return null;
  }
  return {
    // 未知身份使用非合法来源 ID，永远不匹配合法动态作者 ID。
    id: raw.id, author: { id: raw.author.id ?? '',
      nickname: typeof raw.author.nickname === 'string' && raw.author.nickname.trim() ? raw.author.nickname : null,
      avatarUrl: url(raw.author.avatar_url) },
    publishedAt: time(raw.published_at), text: raw.text ?? '',
    likeCount: count(raw.like_count), replyCount: count(raw.source_reply_count),
    // #16 只保留待归档数，不暴露/请求来源 URL；图片读取由 #22 负责。
    pendingMediaCount: raw.media_sources.length,
  };
}

/** 只读本地归档。传输替身不绕过生产 DTO 映射；错误响应/异常永不回显。 */
export function createArchiveReader(transport: ArchiveTransport = (url, init) => fetch(url, init)): DynamicReader {
  return {
    creator: { id: 'archive', nickname: '归档动态', avatarUrl: null },
    replies: 'not-archived',
    async readUps({ signal }): Promise<ReadResult<readonly User[]>> {
      if (signal.aborted) return { status: 'cancelled' };
      try {
        const response = await transport('/api/archive/ups', { method: 'GET', signal });
        const body: unknown = await response.json();
        if (signal.aborted) return { status: 'cancelled' };
        if (response.status !== 200 || !record(body) || !Array.isArray(body.ups)) return failed;
        const users: User[] = [];
        for (const raw of body.ups) {
          if (!record(raw) || !isValidId(raw.id) || users.some(user => user.id === raw.id)) return failed;
          users.push({ id: raw.id, nickname: typeof raw.nickname === 'string' && raw.nickname.trim() ? raw.nickname : null,
            avatarUrl: url(raw.avatar_url) });
        }
        return { status: 'success', data: users };
      } catch { return signal.aborted ? { status: 'cancelled' } : failed; }
    },
    async readList({ scope, limit, cursor, signal }): Promise<ReadResult<DynamicBatch>> {
      if (signal.aborted) return { status: 'cancelled' };
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) return failed;
      if (scope.kind === 'up' && !isValidId(scope.upId)) return failed;
      const query = new URLSearchParams({ limit: String(limit), scope: scope.kind });
      if (scope.kind === 'up') query.set('uid', scope.upId);
      if (cursor != null) query.set('cursor', cursor);
      try {
        const response = await transport(`/api/archive/dynamics?${query}`, { method: 'GET', signal });
        const body: unknown = await response.json();
        if (signal.aborted) return { status: 'cancelled' };
        if (record(body) && record(body.error)) {
          if (scope.kind === 'up' && response.status === 404 && body.error.code === 'UNKNOWN_UP') return { status: 'error', reason: 'unknown-up' };
          if (cursor != null && response.status === 422 && body.error.code === 'INVALID_INPUT') return { status: 'error', reason: 'invalid-cursor' };
        }
        if (response.status !== 200 || !record(body) || !Array.isArray(body.items) || body.items.length > limit
          || !(body.next_cursor === null || typeof body.next_cursor === 'string')) return failed;
        const items: Dynamic[] = [];
        for (const raw of body.items) {
          const item = parseArchive(raw);
          if (!item || scope.kind === 'up' && item.author.id !== scope.upId || items.some(existing => existing.id === item.id)) return failed;
          items.push(item);
        }
        return { status: 'success', data: { items, nextCursor: body.next_cursor } };
      } catch { return signal.aborted ? { status: 'cancelled' } : failed; }
    },
    async readDetail({ id: dynamicId, signal }): Promise<DetailResult> {
      if (signal.aborted) return { status: 'cancelled' };
      if (!isValidId(dynamicId)) return { status: 'not-found' };
      try {
        const response = await transport(`/api/archive/dynamics/${dynamicId}`, { method: 'GET', signal });
        if (signal.aborted) return { status: 'cancelled' };
        if (response.status === 404) return { status: 'not-found' };
        const body: unknown = await response.json();
        if (signal.aborted) return { status: 'cancelled' };
        const dynamic = response.status === 200 ? parseArchive(body) : null;
        return dynamic?.id === dynamicId ? { status: 'success', data: dynamic } : failed;
      } catch { return signal.aborted ? { status: 'cancelled' } : failed; }
    },
    async readComments({ dynamicId, sort, cursor, signal }): Promise<ReadResult<CommentBatch>> {
      if (signal.aborted) return { status: 'cancelled' };
      if (!isValidId(dynamicId) || !(sort === 'hot' || sort === 'latest')
        || !(cursor == null || typeof cursor === 'string')) return failed;
      const query = new URLSearchParams({ sort, limit: '20' });
      if (cursor != null) query.set('cursor', cursor);
      try {
        const response = await transport(`/api/archive/dynamics/${dynamicId}/comments?${query}`, { method: 'GET', signal });
        const body: unknown = await response.json();
        if (signal.aborted) return { status: 'cancelled' };
        if (response.status === 422 && record(body) && record(body.error) && body.error.code === 'CURSOR_INVALID')
          return { status: 'error', reason: 'invalid-cursor' };
        if (response.status !== 200 || !record(body) || !Array.isArray(body.items)
          || body.items.length > 20 || !(body.next_cursor === null || typeof body.next_cursor === 'string')) return failed;
        const items: Comment[] = [];
        for (const raw of body.items) {
          const item = parseComment(raw, dynamicId);
          if (!item || items.some(existing => existing.id === item.id)) return failed;
          items.push(item);
        }
        return { status: 'success', data: { items, nextCursor: body.next_cursor } };
      } catch { return signal.aborted ? { status: 'cancelled' } : failed; }
    },
    async readReplies({ signal }) { return signal.aborted ? { status: 'cancelled' } : { status: 'error', reason: 'not-archived' }; },
  };
}
