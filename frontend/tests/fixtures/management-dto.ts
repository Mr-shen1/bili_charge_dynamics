/**
 * 管理状态的生产 DTO 夹具（snake_case，字段与后端契约一致）。
 * Adapter 契约测试与 e2e 共用同一份形状，避免两处各自维护“看起来像后端”的响应。
 */
export const dtoUid = '900719925474099312345';

/** 发现状态：默认「已发布可信窗口」，其余状态由用例覆盖。 */
export function discoveryDto(overrides: Record<string, unknown> = {}) {
  return {
    uid: dtoUid,
    mode: 'recent',
    recent_n: 2,
    enabled: true,
    active: true,
    status: 'discovered',
    attempt: {
      recent_n: 2, started_at: '2026-10-24T19:08:27+00:00', finished_at: '2026-10-24T19:08:28+00:00',
      ids: ['9007199254740993123'], error: null,
    },
    trusted_result: {
      recent_n: 2, ids: ['9007199254740993123', '900707'], exhausted: false,
      discovered_at: '2026-10-24T19:08:28+00:00',
    },
    current_ids: ['9007199254740993123', '900707'],
    retryable: false,
    incomplete: false,
    ...overrides,
  };
}

/** 检查状态：默认「检查无变化 + 正文成功 + 根评论失败」的代表状态。 */
export function checkDto(overrides: Record<string, unknown> = {}) {
  return {
    id: '900707',
    active: true,
    last_checked_at: '2026-10-24T19:08:27+00:00',
    last_succeeded_at: null,
    check_status: 'unchanged',
    observed: { edit_status: 'observed', observed_version: 'v1', source_comment_count: 0 },
    revision: 1,
    work: 'pending',
    check_error: null,
    sync_error: 'SYNC_INCOMPLETE',
    text_last_succeeded_at: '2026-10-24T19:08:30+00:00',
    media_last_succeeded_at: null,
    comment_media_last_succeeded_at: null,
    media_errors: ['MEDIA_UPLOAD_FAILED'],
    comment_media_errors: [],
    synced_version: null,
    synced_comment_count: null,
    local_comment_count: 0,
    local_reply_count: 0,
    comments_last_attempt: 'failed',
    root_comments_last_succeeded_at: null,
    replies_last_succeeded_at: null,
    comments_last_succeeded_at: null,
    root_comments_error: 'ROOT_COMMENTS_FAILED',
    replies_error: null,
    comments_error: 'ROOT_COMMENTS_FAILED',
    parts: { text: 'success', media: 'pending', comments: 'failed', replies: 'success', comment_media: 'pending' },
    ...overrides,
  };
}
