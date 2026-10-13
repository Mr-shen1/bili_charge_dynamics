import type { Page } from '@playwright/test';
import { archive } from '../../fixtures/archive';

export const publicImageUrl = (id: string, position: number) => `https://oss.example.test/archive/${id}/${position}.svg?literal=a%2Fb&v=1`;
export const mediaArchives = Array.from({ length: 25 }, (_, index) => {
  const id = String(1001 + index);
  const size = [1, 4, 9, 12, 3, 0, 1, 1][index] ?? 0;
  const media = Array.from({ length: size }, (_, position) => ({
    id: `image-${id}-${position}`, owner: { type: 'dynamic', id }, position,
    source_url: `https://source.example.test/${id}/${position}.jpg`,
    width: index === 6 || index === 7 ? null : 600,
    height: index === 0 || (index === 3 && position === 11) ? 2400 : index === 6 ? null : 450,
    version: 'v1', status: index === 4 && position === 0 ? 'pending' : index === 4 && position === 1 ? 'failed' : 'success',
    public_url: index === 4 && position < 2 ? null : publicImageUrl(id, position),
    error: index === 4 && position === 1 ? 'MEDIA_UPLOAD_FAILED' : null,
  }));
  return { ...archive, id, author: { ...archive.author, avatar_url: 'https://avatar.example.test/reader.svg' },
    text: index === 3 ? Array.from({ length: 12 }, (_, line) => `动态图正文 ${line + 1}`).join('\n') : size ? '' : `纯文字 ${id}`,
    last_attempt: 'success', media_sources: media.map(item => ({ url: item.source_url, width: item.width, height: item.height })),
    media, work: { text: 'success', media: index === 4 ? 'pending' : 'success', comments: 'success' },
  };
});

// HTTP 边界替身，页面与 DTO 映射保持生产装配；图片用可控公开 HTTPS 服务替代 OSS。
export async function installMediaHttp(page: Page) {
  const requests: string[] = [];
  const attempts = new Map<string, number>();
  const broken = new Set<string>();
  const pauses = new Map<string, Promise<void>>();
  page.on('request', request => { if (request.resourceType() === 'image') requests.push(request.url()); });
  await page.route('https://source.example.test/**', route => route.abort());
  await page.route('https://avatar.example.test/**', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"/>' }));
  await page.route('https://oss.example.test/**', async route => {
    const url = route.request().url();
    attempts.set(url, (attempts.get(url) ?? 0) + 1);
    if (pauses.has(url)) await pauses.get(url);
    if (broken.has(url)) { await route.abort(); return; }
    const long = url.includes('/1001/') || url.includes('/1007/') || url.includes('/1004/11.svg');
    await route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${long ? 2400 : 450}"><rect width="600" height="100%" fill="#475569"/></svg>` });
  });
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/ups')) { await route.fulfill({ json: { ups: [mediaArchives[0]!.author] } }); return; }
    if (url.pathname.endsWith('/comments')) { await route.fulfill({ json: { items: [], next_cursor: null } }); return; }
    if (url.pathname.startsWith('/api/archive/dynamics/')) {
      const item = mediaArchives.find(item => item.id === url.pathname.split('/').at(-1));
      await route.fulfill(item ? { json: item } : { status: 404 }); return;
    }
    const cursor = url.searchParams.get('cursor');
    const offset = cursor === 'second' ? 10 : cursor === 'third' ? 20 : 0;
    await route.fulfill({ json: { items: mediaArchives.slice(offset, offset + 10),
      next_cursor: offset === 0 ? 'second' : offset === 10 ? 'third' : null } });
  });
  return { requests, attempts, broken, pause(url: string) {
    let release!: () => void;
    pauses.set(url, new Promise<void>(resolve => { release = resolve; }));
    return release;
  } };
}
