import { expect, test, type Page } from '@playwright/test';
import { archive } from '../fixtures/archive';
import { rootComment } from '../fixtures/rootComment';
import { installMediaHttp } from './fixtures/media-http';

const nickname = '回复昵称很长但仍与正文自然接续';
const replyText = '这是生产DTO中的长回复正文，换行之后应回到昵称左缘而不是最右侧正文列。'.repeat(20);

// 只替换生产 HTTP 边界；保留真实 DTO 映射、路由、折叠和 ResizeObserver。
async function installDetailHttp(page: Page, text = replyText) {
  await installMediaHttp(page);
  await page.route(`**/api/archive/dynamics/${archive.id}*`, route => route.fulfill({ json: {
    ...archive, text: '详情正文应与作者头像左缘对齐。', media_sources: [],
    work: { text: 'success', media: 'success', comments: 'success' },
  } }));
  await page.route(`**/api/archive/dynamics/${archive.id}/comments?*`, route => route.fulfill({ json: {
    items: [{ ...rootComment, text: '一级评论保持头像与正文的原有缩进。', source_reply_count: 1 }], next_cursor: null,
  } }));
  await page.route(`**/api/archive/dynamics/${archive.id}/comments/${rootComment.id}/replies?*`, route => route.fulfill({ json: {
    items: [{ id: '900719925474099399999', dynamic_id: archive.id, root_id: rootComment.id, parent_id: rootComment.id,
      author: { ...archive.author, nickname }, text, published_at: null, like_count: 0,
      reply_to: { id: '456', nickname: '较长的回复目标昵称', avatar_url: null } }],
    next_cursor: null, source_reply_count: 1, local_reply_count: 1, replies_last_attempt: 'success',
  } }));
}

// 依据用户新图的相对关系断言，不以实现截图生成黄金基准。
test('详情正文对齐头像、评论tab与排序分行，长回复续行回到昵称左缘', async ({ page }) => {
  await installDetailHttp(page);
  for (const width of [1280, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/dynamics/${archive.id}`);
    const article = page.getByRole('article');
    const body = article.getByText('详情正文应与作者头像左缘对齐。', { exact: true });
    await expect(body).toBeVisible();
    // 独立来源：2026-10-14 当前 opus DOM 的708主栏与正文17/29/#2f3238。
    expect.soft((await page.getByRole('main').boundingBox())!.width).toBe(Math.min(width, 708));
    expect.soft(await body.evaluate(element => {
      const style = getComputedStyle(element);
      return { size: style.fontSize, line: style.lineHeight, color: style.color };
    })).toEqual({ size: '17px', line: '29px', color: 'rgb(47, 50, 56)' });
    const avatar = article.getByRole('img', { name: '归档作者的头像' });
    const bodyBox = (await body.boundingBox())!;
    const avatarBox = (await avatar.boundingBox())!;
    expect.soft(bodyBox.x, `${width}: 详情正文与头像对齐`).toBeCloseTo(avatarBox.x, 0);
    const identityBox = (await article.locator('[data-display-identity]').boundingBox())!;
    expect.soft(bodyBox.y - identityBox.y - identityBox.height, `${width}: 详情身份与正文间距`).toBe(12);
    if (width <= 390) {
      const articleBox = (await article.boundingBox())!;
      expect.soft(bodyBox.x - articleBox.x, `${width}: 手机内距`).toBe(16);
      expect.soft(articleBox.x + articleBox.width - bodyBox.x - bodyBox.width, `${width}: 手机右内距`).toBe(16);
    }
    await expect(article.getByRole('button', { name: /评论/ })).toHaveCount(0);
    await expect(article).not.toContainText(/(?:来源)?评论\s*501/);
    const comments = page.getByRole('region', { name: '评论区', exact: true });
    const heading = comments.getByRole('heading', { name: '评论 501', exact: true });
    await expect(heading).toBeVisible();
    const tab = comments.getByRole('button', { name: '来源评论 501', exact: true });
    await expect(tab).toBeVisible();
    await expect(page.getByRole('button', { name: '来源评论 501', exact: true })).toHaveCount(1);
    const tabBox = (await tab.boundingBox())!;
    expect.soft(tabBox.height).toBeGreaterThanOrEqual(44);
    expect.soft(tabBox.width).toBeGreaterThanOrEqual(44);
    const headingBox = (await heading.boundingBox())!;
    const sortBox = (await page.getByRole('group', { name: '评论排序' }).boundingBox())!;
    expect.soft(sortBox.y, `${width}: 排序在独立tab下方`).toBeGreaterThanOrEqual(headingBox.y + headingBox.height);
    expect.soft(await heading.innerText(), `${width}: 自然评论标题`).toBe('评论 501');

    const row = page.locator('[data-reading-id="reply:' + rootComment.id + ':900719925474099399999"]');
    await expect(row).toBeVisible();
    const paragraph = row.locator('p').filter({ hasText: replyText });
    const continuation = await paragraph.evaluate((element, text) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.includes(text)) continue;
        const start = node.textContent.indexOf(text);
        const lines: { x: number; y: number }[] = [];
        for (let index = start; index < node.textContent.length; index++) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect();
          if (!lines.some(line => Math.abs(line.y - rect.y) < 1)) lines.push({ x: rect.x, y: rect.y });
          if (lines.length === 2) return lines[1]!;
        }
      }
      throw new Error('Expected a naturally wrapped reply');
    }, replyText);
    const nicknameLeft = await row.getByText(nickname, { exact: true }).evaluate(element => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 0);
      range.setEnd(element.firstChild!, 1);
      return range.getBoundingClientRect().x;
    });
    expect.soft(continuation.x, `${width}: 回复续行回到昵称左缘`).toBeCloseTo(nicknameLeft, 0);
    const root = page.locator(`[data-reading-id="comment:${rootComment.id}"]`);
    const rootAvatar = (await root.getByRole('img', { name: `${rootComment.author.nickname}的头像`, exact: true }).boundingBox())!;
    const rootText = (await root.getByText('一级评论保持头像与正文的原有缩进。', { exact: true }).boundingBox())!;
    expect.soft(rootAvatar.width).toBe(40);
    await expect(root.getByText('一级评论保持头像与正文的原有缩进。', { exact: true })).toHaveCSS('font-size', '15px');
    await expect(root.getByText('一级评论保持头像与正文的原有缩进。', { exact: true })).toHaveCSS('line-height', '24px');
    expect.soft(rootText.x - rootAvatar.x).toBe(60);
    expect.soft(rootText.y - rootAvatar.y).toBe(34);
    const replyAvatar = (await row.getByRole('img', { name: `${nickname}的头像`, exact: true }).boundingBox())!;
    expect.soft(replyAvatar.width).toBe(24);
    expect.soft(nicknameLeft - replyAvatar.x).toBe(34);
    const likes = row.getByRole('group', { name: '点赞 0', exact: true });
    await expect(likes).toBeVisible();
    await expect(likes.getByText('0', { exact: true })).toBeVisible();
    await expect(likes.getByText('点赞', { exact: true })).toHaveCount(0);
    await expect(row.getByText('UP主', { exact: true })).toBeVisible();
    await expect(row.getByText('回复 @较长的回复目标昵称', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: '展开回复正文', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: '展开回复正文', exact: true })).toHaveText('展开');
    const visibleLines = await paragraph.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight));
    expect.soft(visibleLines, `${width}: 包含身份前缀的六渲染行`).toBe(6);
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: 无全页横溢`).toBe(true);
  }
});

test('列表气泡与蓝色评论tab定位同一区域，tab不重读或重置最新评论范围', async ({ page }) => {
  await installMediaHttp(page);
  const text = Array.from({ length: 50 }, (_, index) => `详情完整正文第 ${index + 1} 行`).join('\n');
  const dynamic = { ...archive, text, media_sources: [], work: { text: 'success', media: 'success', comments: 'success' } };
  await page.route('**/api/archive/dynamics?*', route => route.fulfill({ json: { items: [dynamic], next_cursor: null } }));
  await page.route(`**/api/archive/dynamics/${archive.id}`, route => route.fulfill({ json: dynamic }));
  const queries: string[] = [];
  await page.route(`**/api/archive/dynamics/${archive.id}/comments?*`, route => {
    const url = new URL(route.request().url());
    queries.push(url.search);
    const sort = url.searchParams.get('sort');
    const offset = url.searchParams.has('cursor') ? 20 : 0;
    return route.fulfill({ json: {
      items: Array.from({ length: offset === 0 ? 20 : 5 }, (_, index) => ({ ...rootComment,
        id: String(200 + offset + index), text: `${sort} 评论 ${offset + index}`, source_reply_count: 0 })),
      next_cursor: offset === 0 ? 'second' : null,
    } });
  });
  await page.goto('/');
  await page.getByRole('article').getByRole('button', { name: '来源评论 501', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${archive.id}$`));
  const article = page.getByRole('article');
  await expect(article.getByText(text, { exact: true })).toHaveText(text);
  await expect(article.getByText('2026-03-01 10:03:04', { exact: true })).toBeVisible();
  await expect(article.getByRole('button')).toHaveCount(0);
  await expect(article).not.toContainText(/(?:来源)?评论\s*501/);
  const comments = page.getByRole('region', { name: '评论区', exact: true });
  const rows = comments.getByRole('list', { name: '一级评论', exact: true }).getByRole('listitem');
  const top = () => comments.evaluate(element => element.getBoundingClientRect().top);
  await expect(rows).toHaveCount(20);
  await expect.poll(top).toBeCloseTo(0, 0);
  await comments.getByRole('button', { name: '最新', exact: true }).click();
  await expect(rows.first()).toContainText('latest 评论 0');
  await comments.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await expect(rows).toHaveCount(25);
  const before = [...queries];
  const tab = comments.getByRole('button', { name: '来源评论 501', exact: true });
  await expect(comments.getByRole('heading', { name: '评论 501', exact: true })).toBeVisible();
  await tab.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(tab).toBeFocused();
  await expect(tab).toHaveCSS('outline-style', 'solid');
  await expect(tab).toHaveCSS('outline-width', '2px');
  await comments.evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top + 120));
  await expect.poll(top).toBeCloseTo(-120, 0);
  await page.keyboard.press('Enter');
  await expect.poll(top).toBeCloseTo(0, 0);
  await comments.evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top + 120));
  await tab.click();
  await expect.poll(top).toBeCloseTo(0, 0);
  await expect(comments.getByRole('button', { name: '最新', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(25);
  await expect(rows.last()).toContainText('latest 评论 24');
  expect(queries).toEqual(before);
});

test('回复inline前缀计入实际折叠行数，窗口改变由ResizeObserver重新量测', async ({ page }) => {
  const text = '短正文用于验证窗口改变后重新计算折叠。'.repeat(4);
  await installDetailHttp(page, text);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/dynamics/${archive.id}`);
  const row = page.locator('[data-reading-id="reply:' + rootComment.id + ':900719925474099399999"]');
  const paragraph = row.locator('p').filter({ hasText: text });
  await expect(paragraph).toBeVisible();
  await expect(row.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(0);
  // 同一次访问缩窄，不重新导航或替换阅读器。
  await page.setViewportSize({ width: 360, height: 900 });
  const expand = row.getByRole('button', { name: '展开回复正文', exact: true });
  await expect(expand).toBeVisible();
  const lines = () => paragraph.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight));
  await expect.poll(lines).toBe(6);
  await expand.click();
  await expect.poll(lines).toBeGreaterThan(6);
  await expect(row.getByRole('button', { name: '收起回复正文', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(row.getByRole('button', { name: '收起回复正文', exact: true })).toHaveCount(0);
  await expect.poll(lines).toBeLessThanOrEqual(6);
  expect(await paragraph.locator('[data-display-identity]').evaluate(element => element.tagName)).toBe('SPAN');
  await expect(paragraph.locator('div')).toHaveCount(0);
});
