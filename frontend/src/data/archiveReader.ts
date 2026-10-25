import type { ArchiveMetadata, ArchiveWorkState, Comment, CommentBatch, CommentLocationResult, DetailResult, Dynamic, DynamicImage, ImageOwner, DynamicBatch, DynamicReader, ReadResult, Reply, ReplyBatch, User } from './contracts';
import { replyAppendSize, replyPreviewSize } from './contracts';
import { isValidId } from './identifiers';
import { isRecord as record } from './guards';
import { parseCheck } from './checkStatus';
import { timestamp } from './timestamp';

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
function commentAttempt(value: unknown): value is NonNullable<ArchiveMetadata['commentsLastAttempt']> {
  return value === 'pending' || value === 'success' || value === 'failed' || value === 'unconfirmed';
}
function version(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
function mediaStatus(value: unknown): value is NonNullable<DynamicImage['archiveStatus']> {
  return value === 'pending' || value === 'success' || value === 'failed';
}
function parseImages(raw: unknown, owner: ImageOwner): DynamicImage[] {
  // 旧冻结 cursor 未携带 media；绝不由 media_sources 推断上传成功。
  if (!Array.isArray(raw)) return [];
  const images: DynamicImage[] = [];
  for (const item of raw) {
    if (!record(item) || typeof item.id !== 'string' || !item.id || images.some(image => image.id === item.id)
      || !record(item.owner) || item.owner.type !== owner.type || item.owner.id !== owner.id
      || !mediaStatus(item.status)) continue;
    const publicUrl = item.status === 'success' ? url(item.public_url) : null;
    images.push({ id: item.id, thumbnailUrl: publicUrl, previewUrl: publicUrl,
      width: count(item.width) || null, height: count(item.height) || null, archiveStatus: item.status });
  }
  return images;
}
function parseArchive(raw: unknown): Dynamic | null {
  if (!record(raw) || !isValidId(raw.id) || !record(raw.author) || !isValidId(raw.author.id)
    || typeof raw.text !== 'string' || !contentState(raw.content_state) || !contentState(raw.last_attempt)
    || !editStatus(raw.edit_status)
    || count(raw.local_comment_count) === null || !Array.isArray(raw.media_sources)
    || !(raw.comment_locator === null || record(raw.comment_locator))
    || !version(raw.observed_version) || !version(raw.synced_version)
    || !record(raw.work) || !workState(raw.work.text)
    || !workState(raw.work.media) || !workState(raw.work.comments)
    || !(raw.work.replies === undefined || raw.work.replies === 'pending' || raw.work.replies === 'success')
    || !(raw.comments_last_attempt === undefined || commentAttempt(raw.comments_last_attempt))
    || !(raw.replies_last_attempt === undefined || commentAttempt(raw.replies_last_attempt))
    || !(raw.synced_comment_count === undefined || raw.synced_comment_count === null || count(raw.synced_comment_count) !== null)
    || !(raw.synced_reply_comment_count === undefined || raw.synced_reply_comment_count === null || count(raw.synced_reply_comment_count) !== null)) return null;
  const mediaSources: ArchiveMetadata['mediaSources'][number][] = [];
  for (const source of raw.media_sources) {
    if (!record(source)) return null;
    const sourceUrl = url(source.url, true);
    if (!sourceUrl) return null;
    mediaSources.push({ url: sourceUrl, width: count(source.width) || null, height: count(source.height) || null });
  }
  const status = raw.edit_status;
  const commentSync = raw.comment_sync == null ? null : parseCheck(raw.comment_sync, timestamp);
  if (raw.comment_sync != null && (!commentSync || commentSync.id !== raw.id)) return null;
  return {
    id: raw.id,
    author: { id: raw.author.id, nickname: typeof raw.author.nickname === 'string' && raw.author.nickname.trim() ? raw.author.nickname : null,
      avatarUrl: url(raw.author.avatar_url) },
    publishedAt: time(raw.published_at), text: raw.text, commentCount: count(raw.source_comment_count), images: parseImages(raw.media, { type: 'dynamic', id: raw.id }),
    archive: { commentSync, title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : null,
      editedAt: time(raw.edited_at, true), editStatus: status, contentState: raw.content_state,
      lastAttempt: raw.last_attempt, localCommentCount: Number(raw.local_comment_count),
      localReplyCount: count(raw.local_reply_count),
      rootCommentsLastAttempt: raw.root_comments_last_attempt === 'pending' || raw.root_comments_last_attempt === 'success'
        || raw.root_comments_last_attempt === 'failed' || raw.root_comments_last_attempt === 'unconfirmed' ? raw.root_comments_last_attempt : undefined,
      commentsLastAttempt: raw.comments_last_attempt,
      repliesLastAttempt: raw.replies_last_attempt,
      syncedCommentCount: raw.synced_comment_count === undefined ? undefined : count(raw.synced_comment_count),
      syncedReplyCommentCount: raw.synced_reply_comment_count === undefined ? undefined : count(raw.synced_reply_comment_count),
      mediaSources,
      commentLocator: raw.comment_locator, observedVersion: raw.observed_version, syncedVersion: raw.synced_version,
      work: { text: raw.work.text, media: raw.work.media, comments: raw.work.comments, replies: raw.work.replies } },
  };
}

function parseComment(raw: unknown, dynamicId: string): Comment | null {
  if (!record(raw) || !isValidId(raw.id) || raw.dynamic_id !== dynamicId
    || !(raw.is_pinned === undefined || typeof raw.is_pinned === 'boolean')
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
  const images = parseImages(raw.media, { type: 'comment', id: raw.id });
  return {
    // 未知身份使用非合法来源 ID，永远不匹配合法动态作者 ID。
    id: raw.id, isPinned: raw.is_pinned === true, author: { id: raw.author.id ?? '',
      nickname: typeof raw.author.nickname === 'string' && raw.author.nickname.trim() ? raw.author.nickname : null,
      avatarUrl: url(raw.author.avatar_url) },
    publishedAt: time(raw.published_at), text: raw.text ?? '',
    likeCount: count(raw.like_count), replyCount: count(raw.source_reply_count),
    // 旧冻结评论只含来源元信息时仍表达待归档，不回退来源 URL。
    ...(raw.media === undefined ? {} : { images }),
    pendingMediaCount: Math.max(0, raw.media_sources.length - images.length),
    ...(raw.up_reply === undefined ? {} : { upReply: parseUpReply(raw.up_reply, raw.id) }),
  };
}

// 楼中楼预览用：结构不完整时宁可不展示，也不猜作者或文本。
function parseUpReply(raw: unknown, rootId: string): Reply | null {
  if (raw === null) return null;
  if (!record(raw) || !isValidId(raw.id) || raw.id === rootId
    || !version(raw.text) || !version(raw.published_at)
    || !(raw.like_count === null || count(raw.like_count) !== null)) return null;
  const author = parseReplyAuthor(raw.author);
  const replyTo = raw.reply_to === null || raw.reply_to === undefined ? null : parseReplyAuthor(raw.reply_to);
  if (!author || raw.reply_to !== null && raw.reply_to !== undefined && !replyTo) return null;
  return { id: raw.id, author, publishedAt: time(raw.published_at), text: raw.text ?? '',
    likeCount: count(raw.like_count), replyTo: replyTo?.id ? replyTo : null,
    parentId: typeof raw.parent_id === 'string' && raw.parent_id !== rootId ? raw.parent_id : null };
}

function parseReplyAuthor(raw: unknown): User | null {
  if (!record(raw) || !(raw.id === null || isValidId(raw.id))
    || !version(raw.nickname) || !version(raw.avatar_url)) return null;
  return { id: raw.id ?? '', nickname: typeof raw.nickname === 'string' && raw.nickname.trim() ? raw.nickname : null,
    avatarUrl: url(raw.avatar_url) };
}
function parseReply(raw: unknown, dynamicId: string, rootId: string): Reply | null {
  if (!record(raw) || !isValidId(raw.id) || raw.id === rootId || raw.dynamic_id !== dynamicId || raw.root_id !== rootId
    || !(raw.parent_id === null || isValidId(raw.parent_id)) || raw.parent_id === raw.id || !version(raw.text) || !version(raw.published_at)
    || !(raw.like_count === null || count(raw.like_count) !== null)) return null;
  const author = parseReplyAuthor(raw.author);
  const replyTo = raw.reply_to === null ? null : parseReplyAuthor(raw.reply_to);
  if (!author || raw.reply_to !== null && !replyTo) return null;
  return { id: raw.id, author, publishedAt: time(raw.published_at), text: raw.text ?? '',
    likeCount: count(raw.like_count), replyTo: replyTo?.id ? replyTo : null,
    // 直接回根评论时没有“回复某人”目标；只有回复其他楼才带父评论 ID。
    parentId: raw.parent_id === rootId ? null : raw.parent_id };
}

// 一级评论批次只在结构完整时接受；重复 ID 视为不可读，不静默去重。
function commentBatch(raw: unknown, dynamicId: string, limit: number): CommentBatch | null {
  if (!record(raw) || !Array.isArray(raw.items) || raw.items.length > limit
    || !(raw.next_cursor === null || typeof raw.next_cursor === 'string')) return null;
  const items: Comment[] = [];
  for (const item of raw.items) {
    const parsed = parseComment(item, dynamicId);
    if (!parsed || items.some(existing => existing.id === parsed.id)) return null;
    items.push(parsed);
  }
  return { items, nextCursor: raw.next_cursor };
}

/** 只读本地归档。传输替身不绕过生产 DTO 映射；错误响应/异常永不回显。 */
export function createArchiveReader(transport: ArchiveTransport = (url, init) => fetch(url, init)): DynamicReader {
  return {
    creator: { id: 'archive', nickname: '归档动态', avatarUrl: null },
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
        const batch = response.status === 200 ? commentBatch(body, dynamicId, 20) : null;
        return batch ? { status: 'success', data: batch } : failed;
      } catch { return signal.aborted ? { status: 'cancelled' } : failed; }
    },
    async locateComment({ dynamicId, rootId, sort, signal }): Promise<CommentLocationResult> {
      if (signal.aborted) return { status: 'cancelled' };
      // 非法身份等同于“这个位置没有可读评论”，不探测归档是否存在。
      if (!isValidId(dynamicId) || !isValidId(rootId) || !(sort === 'hot' || sort === 'latest')) return { status: 'not-found' };
      try {
        const response = await transport(
          `/api/archive/dynamics/${dynamicId}/comments/${rootId}/location?${new URLSearchParams({ sort })}`,
          { method: 'GET', signal });
        if (signal.aborted) return { status: 'cancelled' };
        if (response.status === 404) return { status: 'not-found' };
        const body: unknown = await response.json();
        if (signal.aborted) return { status: 'cancelled' };
        if (response.status !== 200) return failed;
        const batch = commentBatch(body, dynamicId, 20);
        // 目标必须就在这一批里：绝不把页首或邻近评论当作定位成功。
        if (!batch || !batch.items.some(item => item.id === rootId)) return failed;
        return { status: 'success', data: batch };
      } catch { return signal.aborted ? { status: 'cancelled' } : failed; }
    },
    async readReplies({ dynamicId, rootId, limit, page, cursor, signal }): Promise<ReadResult<ReplyBatch>> {
      if (signal.aborted) return { status: 'cancelled' };
      if (!isValidId(dynamicId) || !isValidId(rootId) || !(cursor == null || typeof cursor === 'string')) return failed;
      if (page !== undefined) {
        if (!Number.isSafeInteger(page) || page < 1 || limit !== replyAppendSize || cursor != null) return failed;
      } else if (limit !== (cursor == null ? replyPreviewSize : replyAppendSize)) return failed;
      const query = new URLSearchParams(page !== undefined ? { page: String(page), limit: String(limit) } : { limit: String(limit) });
      if (cursor != null) query.set('cursor', cursor);
      try {
        const response = await transport(`/api/archive/dynamics/${dynamicId}/comments/${rootId}/replies?${query}`, {
          method: 'GET', signal, ...(page !== undefined ? { cache: 'no-store' } : {}),
        });
        const body: unknown = await response.json();
        if (signal.aborted) return { status: 'cancelled' };
        if (response.status === 422 && record(body) && record(body.error) && body.error.code === 'CURSOR_INVALID')
          return { status: 'error', reason: 'invalid-cursor' };
        if (response.status !== 200 || !record(body) || !Array.isArray(body.items)
          || body.items.length > limit || !(body.next_cursor === null || typeof body.next_cursor === 'string')) return failed;
        const total = count(body.count);
        if (page !== undefined && (total === null || body.next_cursor !== null)) return failed;
        if (body.replies_last_attempt !== undefined && !commentAttempt(body.replies_last_attempt)) return failed;
        for (const key of ['source_reply_count', 'local_reply_count', 'synced_source_reply_count']) {
          if (body[key] !== undefined && body[key] !== null && count(body[key]) === null) return failed;
        }
        const items: Reply[] = [];
        for (const raw of body.items) {
          const item = parseReply(raw, dynamicId, rootId);
          if (!item || items.some(existing => existing.id === item.id)) return failed;
          items.push(item);
        }
        const root = body.root === undefined || body.root === null ? null : parseComment(body.root, dynamicId);
        if (body.root !== undefined && body.root !== null && !root) return failed;
        if (page !== undefined && (!root || root.id !== rootId)) return failed;
        return { status: 'success', data: { items, nextCursor: body.next_cursor,
          ...(page !== undefined && total !== null ? { count: total } : {}),
          ...(root ? { root } : {}),
          ...(body.source_reply_count !== undefined ? { sourceReplyCount: count(body.source_reply_count) } : {}),
          ...(body.local_reply_count !== undefined ? { localReplyCount: count(body.local_reply_count) } : {}),
          ...(commentAttempt(body.replies_last_attempt) ? { repliesLastAttempt: body.replies_last_attempt } : {}),
          ...(body.synced_source_reply_count !== undefined ? { syncedSourceReplyCount: count(body.synced_source_reply_count) } : {}),
        } };
      } catch { return signal.aborted ? { status: 'cancelled' } : failed; }
    },
  };
}
