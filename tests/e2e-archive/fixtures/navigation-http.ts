import type { Page } from '@playwright/test';

// 仅替换浏览器 HTTP 边界；页面仍经过生产 createArchiveReader DTO/分页映射。
const author = { id: '123', nickname: '虚构作者一', avatar_url: 'https://example.invalid/navigation-avatar.svg' };
const unnamedAuthor = { id: '456', nickname: null, avatar_url: null };
const ups = [
  author,
  unnamedAuthor,
  ...Array.from({ length: 18 }, (_, index) => ({
    id: String(700 + index), nickname: `虚构长昵称归档作者 ${index + 1} ${'长昵称'.repeat(12)}`, avatar_url: null,
  })),
];
const longText = Array.from({ length: 8 }, (_, line) => `归档正文第 ${line + 1} 行：可选择的文字 😀`).join('\n');
const dynamics = Array.from({ length: 25 }, (_, index) => ({
  id: String(1001 + index), author: index % 2 === 0 ? author : unnamedAuthor,
  published_at: `2026-03-${String(28 - Math.floor(index / 2)).padStart(2, '0')}T10:00:00+08:00`,
  edited_at: null, edit_status: 'unknown', text: index === 0 ? longText : `虚构跨范围正文 ${1001 + index}`,
  content_state: 'success', last_attempt: 'success', source_comment_count: 7, local_comment_count: 0,
  media_sources: [], comment_locator: null, observed_version: 'fixture-v1', synced_version: 'fixture-v1',
  work: { text: 'success', media: 'pending', comments: 'pending' },
}));

export async function installNavigationHttp(page: Page) {
  await page.route('https://example.invalid/navigation-avatar.svg', route => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><circle cx="22" cy="22" r="22" fill="#00a6c8"/></svg>',
  }));
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/archive/ups') {
      await route.fulfill({ json: { ups } });
      return;
    }
    if (url.pathname.startsWith('/api/archive/dynamics/')) {
      const item = dynamics.find(item => item.id === url.pathname.split('/').at(-1));
      await route.fulfill(item ? { json: item } : { status: 404, json: { error: { code: 'NOT_FOUND' } } });
      return;
    }
    const uid = url.searchParams.get('uid');
    const scope = url.searchParams.get('scope');
    const cursor = url.searchParams.get('cursor');
    const key = scope === 'all' && uid === null ? 'all' : scope === 'up' && ups.some(up => up.id === uid) ? `up-${uid}` : null;
    // cursor 是 HTTP fixture 的不透明字面值；不接纳其他 scope 的分页标记。
    const offset = cursor === null ? 0 : cursor === `${key}-second` ? 10 : cursor === `${key}-third` ? 20 : -1;
    if (url.pathname !== '/api/archive/dynamics' || url.searchParams.get('limit') !== '10' || key === null || offset < 0) {
      await route.fulfill({ status: 422, json: { error: { code: 'INVALID_INPUT' } } });
      return;
    }
    const items = scope === 'all' ? dynamics : dynamics.filter(item => item.author.id === uid);
    await route.fulfill({ json: {
      items: items.slice(offset, offset + 10),
      next_cursor: offset + 10 >= items.length ? null : `${key}-${offset === 0 ? 'second' : 'third'}`,
    } });
  });
}
