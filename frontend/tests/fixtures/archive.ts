/** 生产 DTO 夹具：与后端归档读取契约一致，页面测试经由真实 Adapter 映射。 */
export const archive = {
  id: '900719925474099312345',
  author: { id: '123', nickname: '归档作者', avatar_url: null },
  published_at: '2026-03-01T10:03:04+08:00',
  edited_at: '2026-03-02T13:01+08:00',
  edit_status: 'observed',
  text: '<script>not executable</script>\n归档正文',
  content_state: 'success',
  last_attempt: 'failed',
  source_comment_count: 501,
  local_comment_count: 0,
  media_sources: [{ url: 'https://upstream.example.test/image.jpg', width: 800, height: 1200 }],
  comment_locator: { oid: '900719925474099312345', type: 17 },
  observed_version: 'v2',
  synced_version: 'v1',
  work: { text: 'pending', media: 'pending', comments: 'pending' },
};

export function archiveUser(id: string, nickname: string | null) {
  return { id, nickname, avatar_url: null };
}

/** 列表第 index 条（从 1 开始），只覆盖展示相关字段，其余保持合法 DTO。 */
export function archiveDynamic(index: number, overrides: Record<string, unknown> = {}) {
  return {
    ...archive,
    id: String(1000 + index),
    text: `归档正文 ${index}`,
    source_comment_count: index - 1,
    ...overrides,
  };
}
