import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4174' });

test('第二批追加失败保留展开及阅读位置，原位置重试后读完 25 条', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('article')).toHaveCount(10);
  await page.getByRole('article').first().getByRole('button', { name: '展开正文' }).click();
  const more = page.getByRole('button', { name: '加载更多' });
  await more.scrollIntoViewIfNeeded();
  const pixelY = await page.evaluate(() => window.scrollY);
  await more.click();
  await expect(more).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('动态追加读取失败');
  await expect(page.getByRole('article')).toHaveCount(10);
  await expect(page.getByRole('article').first().getByRole('button', { name: '收起正文' })).toHaveCount(1);
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(pixelY, 0);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByRole('article')).toHaveCount(25);
  await expect(page.getByText('动态已加载完毕')).toBeVisible();
});

test('专用故障装配确定性列表/详情失败重试，长昵称不撑宽页面', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('动态列表读取失败');
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('article')).toHaveCount(10);
  await page.getByRole('button', { name: '查看详情' }).first().click();
  await expect(page.getByRole('alert')).toContainText('动态详情读取失败');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText(/第八行/)).toBeVisible();
});

for (const areaName of ['comments', 'replies'] as const) {
  test(`讨论${areaName}追加加载中离开再返回，保留成功内容并继续原批而不永久加载`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByRole('article').first().getByRole('button', { name: '查看详情', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('动态详情读取失败');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    const comments = page.getByRole('region', { name: '评论区', exact: true });
    const commentRows = comments.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
    const replies = page.getByRole('region', { name: '回复区 comment-44', exact: true });
    await expect(commentRows).toHaveCount(20);
    await expect(replies.getByRole('listitem')).toHaveCount(3);
    if (areaName === 'comments') await comments.getByRole('button', { name: '加载更多评论', exact: true }).click();
    else await replies.getByRole('button', { name: '展开回复', exact: true }).click();
    const region = areaName === 'comments' ? comments : replies;
    await expect(region.getByText(areaName === 'comments' ? '最热评论追加加载中…' : '回复追加加载中…', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回列表', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.goForward();
    await expect(page.getByRole('alert')).toHaveCount(0);
    if (areaName === 'comments') {
      await expect(commentRows).toHaveCount(40);
      await comments.getByRole('button', { name: '加载更多评论', exact: true }).click();
      await expect(commentRows).toHaveCount(45);
    } else {
      await expect(replies.getByRole('listitem')).toHaveCount(13);
      await replies.getByRole('button', { name: '加载更多回复', exact: true }).click();
      await expect(replies.getByRole('listitem')).toHaveCount(23);
    }
    await expect(region.getByText('读取已取消，可重新读取。', { exact: true })).toHaveCount(0);
    await expect(region.getByText(/加载中…/)).toHaveCount(0);
  });
}
