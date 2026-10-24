import type { Comment, Reply, User } from '../../src/data/contracts';

export const replyAuthor: User = { id: '7002', nickname: '回复作者', avatarUrl: null };

/** 回复领域夹具：默认直接回根（parentId 为 null），按用例覆盖嵌套目标与正文。 */
export function reply(index: number, overrides: Partial<Reply> = {}): Reply {
  return {
    id: String(9000 + index),
    author: replyAuthor,
    publishedAt: '2026-03-01T10:03:04+08:00',
    text: `回复 ${index}`,
    likeCount: index,
    replyTo: null,
    parentId: null,
    ...overrides,
  };
}

/** 25 条回复，按时间正序返回；调用方按 3 与 10/10/5 切片。 */
export function replies(total = 25): Reply[] {
  return Array.from({ length: total }, (_value, index) => reply(index + 1));
}

/** 生产 DTO 夹具：与后端回复契约一致，adapter 契约测试经由真实映射。 */
export function archiveReply(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(9000 + index),
    dynamic_id: '1001',
    root_id: '5001',
    parent_id: '5001',
    author: { id: '7002', nickname: '回复作者', avatar_url: null },
    reply_to: null,
    published_at: '2026-03-01T10:03:04+08:00',
    text: `回复 ${index}`,
    like_count: index,
    ...overrides,
  };
}

/** page 模式每页都返回的根评论（id 与请求的 rootId 一致）。 */
export function archiveRoot(overrides: Partial<Comment> = {}) {
  return {
    id: '5001',
    dynamic_id: '1001',
    author: { id: '7001', nickname: '评论作者', avatar_url: null },
    published_at: '2026-03-01T10:03:04+08:00',
    text: '一级评论 1',
    like_count: 1,
    source_reply_count: 25,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
    ...overrides,
  };
}
