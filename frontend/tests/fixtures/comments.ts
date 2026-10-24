import type { ArchiveMetadata, Comment, Dynamic, User } from '../../src/data/contracts';
import type { TargetCheck } from '../../src/data/checkStatus';

export const commentAuthor: User = { id: '7001', nickname: '评论作者', avatarUrl: null };

/** 一级评论领域夹具：默认合法最小对象，按用例覆盖排序/折叠/身份/计数相关字段。 */
export function comment(index: number, overrides: Partial<Comment> = {}): Comment {
  return {
    id: String(5000 + index),
    isPinned: false,
    author: commentAuthor,
    publishedAt: '2026-03-01T10:03:04+08:00',
    text: `一级评论 ${index}`,
    likeCount: index,
    replyCount: 0,
    ...overrides,
  };
}

/** 45 条一级评论，按 id 顺序返回；调用方自行切片模拟 20/20/5。 */
export function comments(total = 45): Comment[] {
  return Array.from({ length: total }, (_value, index) => comment(index + 1));
}

export function targetCheck(overrides: Partial<TargetCheck> = {}): TargetCheck {
  return {
    id: '1001',
    active: true,
    checkStatus: 'checked',
    work: 'complete',
    revision: 1,
    lastCheckedAt: '2026-03-01T10:00:00+08:00',
    lastSucceededAt: '2026-03-01T10:00:00+08:00',
    textLastSucceededAt: null,
    mediaLastSucceededAt: null,
    commentMediaLastSucceededAt: null,
    mediaErrors: [],
    commentMediaErrors: [],
    observedVersion: 'v1',
    syncedVersion: 'v1',
    editStatus: 'unknown',
    sourceCommentCount: 45,
    localCommentCount: 45,
    localReplyCount: 0,
    commentCountStatus: 'observed',
    commentsLastAttempt: 'success',
    syncedCommentCount: 45,
    rootCommentsLastSucceededAt: null,
    repliesLastSucceededAt: null,
    commentsLastSucceededAt: null,
    rootCommentsError: null,
    repliesError: null,
    commentsError: null,
    checkError: null,
    syncError: null,
    parts: { text: 'success', media: 'success', comments: 'success', replies: 'success', comment_media: 'success' },
    ...overrides,
  };
}

export function commentArchive(overrides: Partial<ArchiveMetadata> = {}): ArchiveMetadata {
  return {
    commentSync: null,
    title: null,
    editedAt: null,
    editStatus: 'unknown',
    contentState: 'success',
    lastAttempt: 'success',
    localCommentCount: 45,
    rootCommentsLastAttempt: 'success',
    commentsLastAttempt: 'success',
    mediaSources: [],
    commentLocator: null,
    observedVersion: null,
    syncedVersion: null,
    work: { text: 'success', media: 'success', comments: 'success' },
    ...overrides,
  };
}

/** 详情领域夹具：正文与作者无关字段保持稳定，评论相关状态由用例覆盖。 */
export function commentDynamic(overrides: Partial<Dynamic> = {}): Dynamic {
  return {
    id: '1001',
    author: { id: '123', nickname: '动态作者', avatarUrl: null },
    publishedAt: '2026-03-01T10:03:04+08:00',
    text: '详情正文',
    commentCount: 45,
    archive: commentArchive(),
    ...overrides,
  };
}

/** 生产 DTO 夹具：与后端根评论契约一致，adapter 契约测试经由真实映射。 */
export function archiveComment(index: number, overrides: Record<string, unknown> = {}) {
  const id = String(5000 + index);
  return {
    id,
    dynamic_id: '1001',
    author: { id: '7001', nickname: '评论作者', avatar_url: null },
    published_at: '2026-03-01T10:03:04+08:00',
    text: `一级评论 ${index}`,
    like_count: index,
    source_reply_count: index % 3,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
    ...overrides,
  };
}
