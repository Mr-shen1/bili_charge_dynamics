import type { Page } from '@playwright/test';
import { installMediaHttp, publicImageUrl } from './media-http';

export const commentImageUrl = (id: string, position: number) => publicImageUrl(`comments/${id}`, position);
export const longNickname = `长昵称${'ReaderWithoutSpaces'.repeat(12)}`;

function comment(id: string, size: number, text = '', nickname = `评论作者 ${id}`) {
  const media = Array.from({ length: size }, (_, position) => ({
    // 刻意与动态图复用图片 ID；隔离必须来自 owner，而非碰巧不同的 ID。
    id: `image-1004-${position}`, owner: { type: 'comment', id }, position,
    source_url: `https://source.example.test/comments/${id}/${position}.jpg`,
    width: id === '1007' ? null : 600,
    height: id === '1007' ? null : id === '1001' || id === '1004' && position === 11 ? 2400 : 450,
    version: 'v1', status: id === '2003' && position === 0 ? 'pending' : id === '2003' && position === 1 ? 'failed' : 'success',
    public_url: id === '2003' && position < 2 ? null : commentImageUrl(id, position),
    error: id === '2003' && position === 1 ? 'MEDIA_UPLOAD_FAILED' : null,
  }));
  return {
    id, dynamic_id: '1004', root_id: '0', parent_id: '0',
    author: { id: '456', nickname, avatar_url: 'https://avatar.example.test/comment.svg' },
    published_at: '2026-03-01T10:03:04+08:00', text, like_count: 1, source_reply_count: 0,
    comment_locator: null,
    media_sources: media.map(image => ({ url: image.source_url, width: image.width, height: image.height })), media,
  };
}

export const commentMediaItems = [
  comment('1001', 1),
  comment('2002', 4, '四图评论正文', longNickname),
  comment('2003', 3),
  comment('2004', 0, '纯文字评论'),
  comment('2005', 0),
  comment('1007', 1),
  // 让末组真正处于浏览器懒加载阈值之外；不注入 CSS 或替换 UI。
  ...Array.from({ length: 12 }, (_, index) => comment(String(5000 + index), 0,
    Array.from({ length: 15 }, (_, line) => `占位评论正文 ${line + 1}`).join('\n'))),
  // 动态 ID 与评论 ID 相等，且图片 ID 重合，仍须保留十二张独立评论图。
  comment('1004', 12),
];

// 只替换 HTTP/图片边界；后注册的评论 route 覆盖 installMediaHttp 的空评论。
export async function installCommentMediaHttp(page: Page) {
  const service = await installMediaHttp(page);
  const commentReads: string[] = [];
  await page.route('**/api/archive/dynamics/1004/comments?*', async route => {
    const url = new URL(route.request().url());
    commentReads.push(url.search);
    await route.fulfill({ json: {
      items: url.searchParams.get('sort') === 'latest' ? [comment('4000', 0, '排序后的评论')] : commentMediaItems,
      next_cursor: null,
    } });
  });
  return { ...service, commentReads };
}
