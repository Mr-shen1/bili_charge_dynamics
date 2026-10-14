import { expect, test } from '@playwright/test';
import { installMediaHttp, mediaArchives, publicImageUrl } from './fixtures/media-http';

// 用户新列表图：两图是同高、不同宽度的阅读容器；单图宽度来自实际页面360px量测。
test('生产两图同高比例容器，未知未归档图不请求来源；保留owner与焦点，单图限宽', async ({ page }) => {
  const sourceRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).hostname === 'source.example.test') sourceRequests.push(request.url());
  });
  await installMediaHttp(page);
  const original = mediaArchives[1]!;
  const media = original.media.slice(0, 2).map((image, index) => index === 0
    ? { ...image, width: 600, height: 2400 }
    : { ...image, status: 'pending', public_url: null, width: null, height: null });
  await page.route('**/api/archive/dynamics/1002', route => route.fulfill({ json: {
    ...original, media, work: { ...original.work, media: 'pending' },
    media_sources: media.map(image => ({ url: image.source_url, width: image.width, height: image.height })),
  } }));
  await page.route(publicImageUrl('1002', 0), route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="2400"><rect width="600" height="2400" fill="#e9f5ee"/></svg>' }));
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dynamics/1002');
    const group = page.getByRole('group', { name: '动态图片', exact: true });
    const buttons = group.getByRole('button', { name: /^预览图片/ });
    await expect(buttons).toHaveCount(2);
    const first = (await buttons.nth(0).boundingBox())!;
    const second = (await buttons.nth(1).boundingBox())!;
    expect(first.y).toBeCloseTo(second.y, 0);
    expect(first.height).toBeCloseTo(second.height, 0);
    expect(first.height).toBeLessThanOrEqual(268);
    expect(first.width / first.height).toBeCloseTo(3 / 4, 2);
    expect(second.width / second.height).toBeCloseTo(4 / 3, 2);
    for (const image of await group.getByRole('img').all()) await expect(image).toHaveCSS('object-fit', 'contain');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await buttons.nth(0).click();
    const preview = page.getByRole('dialog', { name: '图片预览' });
    await expect(preview.getByRole('img')).toHaveAttribute('src', publicImageUrl('1002', 0));
    await expect(preview.getByText('1 / 2', { exact: true })).toBeVisible();
    await preview.getByRole('button', { name: '下一张', exact: true }).click();
    await expect(preview.getByText('2 / 2', { exact: true })).toBeVisible();
    await expect(preview.getByText('图片待归档', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(buttons.nth(0)).toBeFocused();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/dynamics/1007');
  const single = page.getByRole('group', { name: '动态图片', exact: true });
  expect((await single.boundingBox())!.width).toBeLessThanOrEqual(360);
  expect(sourceRequests).toEqual([]);
});
