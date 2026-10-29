// @projects desktop-chromium, mobile-chromium
import { expect, test, type Page } from '@playwright/test';

// 详情与阅读恢复跑 mock 装配的真实浏览器行为：确定性 25 条归档，不依赖后端。
// 滚动、锚点、历史与布局都由浏览器真实执行，jsdom 无法替代。

// mock 装配的首条动态与带 25 条回复的一级评论（与 src/mock/archiveReader.ts 的夹具身份一致）。
const mainDynamicId = '90071992547409931';
const rootWithReplies = '90071992547401001';

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(window.scrollY));
}

async function scrollWindowTo(page: Page, top: number): Promise<number> {
  return page.evaluate(value => { window.scrollTo(0, value); return Math.round(window.scrollY); }, top);
}

async function alignTop(card: ReturnType<Page['getByRole']>, offset: number): Promise<void> {
  await card.evaluate((element, value) => {
    window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - value);
  }, offset);
}

test.describe('动态详情与阅读恢复', () => {
  test('卡片进入详情顶部并全文展示，返回恢复来源列表的批次、展开与锚点', async ({ page }) => {
    // 宽屏正文入口在独立标签页打开；站内往返（来源、返回、位置）按窄屏语义验证。
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/');
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(10);
    await cards.first().getByRole('button', { name: '展开正文' }).click();
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(cards).toHaveCount(20);

    const anchor = cards.nth(5);
    await alignTop(anchor, 40);
    const offset = await anchor.evaluate(element => Math.round(element.getBoundingClientRect().top));
    const id = await anchor.getAttribute('data-reading-id');

    await anchor.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page).toHaveURL(new RegExp(`/dynamics/${id}$`));
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    // 主动入口从顶部开始，且详情正文不再折叠。
    await expect.poll(() => scrollY(page)).toBe(0);
    await expect(page.getByRole('article')).toHaveCount(1);
    await expect(page.getByRole('article').getByRole('button', { name: '展开正文' })).toHaveCount(0);

    // 返回时布局宽度变化，仍按稳定锚点恢复视口偏移。
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole('button', { name: '‹ 动态列表' }).click();
    await expect(cards).toHaveCount(20);
    await expect(cards.first().getByRole('button', { name: '收起正文' })).toHaveCount(1);
    // 窄屏布局的行高与换行使滚动位置落在次像素上，按锚点恢复允许 1px 取整差。
    await expect.poll(async () => Math.abs(
      await anchor.evaluate(element => Math.round(element.getBoundingClientRect().top)) - offset,
    )).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(cards).toHaveCount(25);
    await expect(page.getByText('动态已加载完毕')).toBeVisible();
  });

  test('单 UP 来源返回对应范围列表，不跳到全部动态', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/ups/123');
    await expect(page.getByRole('heading', { name: 'UP 123 动态' })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.getByRole('button', { name: '加载更多' }).click();
    const loaded = await page.getByRole('article').count();
    expect(loaded).toBeGreaterThan(10);

    await page.getByRole('article').nth(3).getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await page.getByRole('button', { name: '‹ 动态列表' }).click();
    await expect(page).toHaveURL(/\/ups\/123$/);
    await expect(page.getByRole('heading', { name: 'UP 123 动态' })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(loaded);
    await expect(page.getByRole('link', { name: '纸飞机' })).toHaveAttribute('aria-current', 'page');
  });

  test('浏览器后退同样恢复列表；新的列表访问不沿用旧详情位置', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('article')).toHaveCount(20);
    const anchor = page.getByRole('article').nth(7);
    await alignTop(anchor, 30);
    const offset = await anchor.evaluate(element => Math.round(element.getBoundingClientRect().top));

    await anchor.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(20);
    await expect.poll(() => anchor.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(offset);

    // 再次主动进入同一动态是新的访问，从顶部而不是上次位置开始。
    const detail = anchor.getByRole('link', { name: /^阅读全文 / });
    await detail.click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await scrollWindowTo(page, 160);
    // 01 去掉了公共顶栏，不再有“详情 → 列表”的品牌链接：先浏览器后退回到列表，
    // 再从 UP 条进单 UP 列表、由第一项「全部动态」开一次新的首页访问（同会话、不同历史记录）。
    await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(20);
    // 用 DOM 点击避免浏览器把 UP 条滚进视口：那会把离开列表时的位置记成 0。
    await page.getByRole('link', { name: '纸飞机', exact: true })
      .evaluate(element => (element as HTMLElement).click());
    await expect(page.getByRole('heading', { name: 'UP 123 动态' })).toBeVisible();
    await page.getByRole('link', { name: '全部动态', exact: true })
      .evaluate(element => (element as HTMLElement).click());
    await expect(page).toHaveURL(/\/$/);
    // 新的列表访问从首批与顶部开始，不继承旧列表的 20 条与位置。
    await expect(page.getByRole('article')).toHaveCount(10);
    await expect.poll(() => scrollY(page)).toBe(0);

    // 一路后退：新列表仍只有自己的 10 条，单 UP 列表与最早那次首页访问各有自己的状态。
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'UP 123 动态' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(20);
    await expect.poll(() => anchor.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(offset);
  });

  test('同一动态的两次访问各自保存位置：第二次不继承第一次，列表访问也不被覆盖', async ({ page }) => {
    // 视口压到内容高度以下，保证详情确实可滚动；位置差异仍由真实浏览器历史恢复。
    await page.setViewportSize({ width: 390, height: 320 });
    await page.goto('/');
    const card = page.getByRole('article').nth(2);
    const link = card.getByRole('link', { name: /^阅读全文 / });
    await expect(card).toContainText('长词');

    await link.click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    const first = await scrollWindowTo(page, 300);
    expect(first).toBeGreaterThan(40);

    // 回到列表再主动进入同一动态：01 去掉了公共顶栏，站内入口改成「浏览器后退 + 卡片链接」。
    await page.goBack();
    await expect(page.getByRole('article').first()).toBeVisible();
    await page.getByRole('article').nth(2).getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    // 新的访问不继承上一次的位置。
    await expect.poll(() => scrollY(page)).toBe(0);
    const second = await scrollWindowTo(page, Math.floor(first / 2));
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);

    // 后退回到列表，前进回到第二次访问：各自的位置互不覆盖。
    await page.goBack();
    await expect(page.getByRole('article').first()).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect.poll(() => scrollY(page)).toBe(second);
  });

  test('恢复尚未执行时用户滚动优先，迟到帧不再把人拉回旧位置', async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('article')).toHaveCount(20);
    const anchor = page.getByRole('article').nth(12);
    await anchor.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect.poll(() => scrollY(page)).toBe(0);

    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    await page.getByRole('button', { name: '‹ 动态列表' }).evaluate(element => (element as HTMLButtonElement).click());
    await expect(page.getByRole('article')).toHaveCount(20);
    const wheelReceived = page.evaluate(() => new Promise<void>(resolve => {
      window.addEventListener('wheel', () => resolve(), { once: true });
    }));
    await page.mouse.wheel(0, 300);
    await wheelReceived;
    await page.clock.runFor(100);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(0);
    const afterUser = await scrollY(page);
    await page.clock.runFor(600);
    expect(await scrollY(page)).toBe(afterUser);
  });

  test('阅读排版标尺：正文、作者、元信息、拿点、返回链接与卡片边距', async ({ page }) => {
    for (const width of [360, 390, 768, 1280]) {
      const compact = width <= 640;
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await expect(page.getByRole('article').first()).toBeVisible();

      const list = await page.evaluate(() => {
        const cards = [...document.querySelectorAll<HTMLElement>('.dynamic-card')];
        const card = cards[0]!;
        const style = (node: Element) => getComputedStyle(node);
        const body = card.querySelector<HTMLElement>('.text')!;
        const author = card.querySelector<HTMLElement>('.nickname')!;
        const time = card.querySelector<HTMLElement>('.time')!;
        const strip = document.querySelector<HTMLElement>('.up-strip')!;
        const cardBox = card.getBoundingClientRect();
        return {
          bodyFont: style(body).fontSize,
          bodyLine: style(body).lineHeight,
          bodyColor: style(body).color,
          authorFont: style(author).fontSize,
          authorLine: style(author).lineHeight,
          authorWeight: style(author).fontWeight,
          timeFont: style(time).fontSize,
          timeLine: style(time).lineHeight,
          timeColor: style(time).color,
          cardPaddingTop: style(card).paddingTop,
          cardPaddingLeft: style(card).paddingLeft,
          cardWidth: Math.round(cardBox.width),
          cardGap: Math.round(cards[1]!.getBoundingClientRect().top - cardBox.bottom),
          stripLeft: Math.round(strip.getBoundingClientRect().left),
          cardLeft: Math.round(cardBox.left),
          stripRight: Math.round(strip.getBoundingClientRect().right),
          cardRight: Math.round(cardBox.right),
        };
      });
      const pad = compact ? '16px' : '24px';
      expect(list.bodyFont, `${width}px 正文字号`).toBe('16px');
      expect(list.bodyLine, `${width}px 正文行高`).toBe('28px');
      expect(list.bodyColor, `${width}px 正文颜色`).toBe('rgb(48, 56, 61)');
      expect(list.authorFont, `${width}px 作者字号`).toBe('16px');
      expect(list.authorLine, `${width}px 作者行高`).toBe('24px');
      expect(list.authorWeight, `${width}px 作者字重`).toBe('600');
      expect(list.timeFont, `${width}px 时间字号`).toBe('13px');
      expect(list.timeLine, `${width}px 时间行高`).toBe('20px');
      // 辅助文字色 #65727a，不再用低对比浅灰。
      expect(list.timeColor, `${width}px 时间颜色`).toBe('rgb(101, 114, 122)');
      expect(list.cardPaddingTop, `${width}px 卡片内距（上）`).toBe(pad);
      expect(list.cardPaddingLeft, `${width}px 卡片内距（左）`).toBe(pad);
      expect(list.cardGap, `${width}px 卡片间距`).toBe(compact ? 12 : 16);
      // 主栏约 724px：窄屏占满视口减去 12px 留白，桌面保持 724px。
      expect(list.cardWidth, `${width}px 主栏宽度`).toBe(compact ? width - 24 : 724);
      // 选择条与卡片左右边缘对齐。
      expect(list.stripLeft, `${width}px 左边缘`).toBe(list.cardLeft);
      expect(list.stripRight, `${width}px 右边缘`).toBe(list.cardRight);
    }
  });

  test('详情与楼中楼：返回链接 14/22 常规字重与 44px 点击区', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/dynamics/${mainDynamicId}`);
    await expect(page.locator('.detail-card')).toBeVisible();
    const detail = await page.evaluate(() => {
      const back = document.querySelector<HTMLElement>('.detail-back')!;
      const card = document.querySelector<HTMLElement>('.detail-card')!;
      const style = (node: Element) => getComputedStyle(node);
      return {
        backFont: style(back).fontSize,
        backLine: style(back).lineHeight,
        backWeight: style(back).fontWeight,
        backColor: style(back).color,
        backHeight: Math.round(back.getBoundingClientRect().height),
        cardLeft: Math.round(card.getBoundingClientRect().left),
        cardLine: style(card.querySelector<HTMLElement>('.text')!).lineHeight,
      };
    });
    expect(detail.backFont).toBe('14px');
    expect(detail.backLine).toBe('22px');
    expect(detail.backWeight).toBe('400');
    // 操作色 #287f8f。
    expect(detail.backColor).toBe('rgb(40, 127, 143)');
    expect(detail.backHeight).toBeGreaterThanOrEqual(44);
    // 详情正文同样按 16/28 完整展示，不被行高改动裁掉。
    expect(detail.cardLine).toBe('28px');

    // 一级评论也按同一标尺：昵称 14/22、正文 15/26、时间计数 13/20、徽标 12/20。
    const firstComment = page.getByRole('list', { name: '一级评论' }).getByRole('listitem').first();
    await expect(firstComment).toBeVisible();
    const comment = await firstComment.evaluate(node => {
      const style = (selector: string) => getComputedStyle(node.querySelector<HTMLElement>(selector)!);
      const nickname = style('.comment__nickname');
      const body = style('.comment__body > .text');
      const metrics = style('.comment__metrics');
      const badge = style('.comment__badge');
      return {
        nickname: [nickname.fontSize, nickname.lineHeight],
        body: [body.fontSize, body.lineHeight],
        metrics: [metrics.fontSize, metrics.lineHeight],
        badge: [badge.fontSize, badge.lineHeight],
      };
    });
    expect(comment.nickname).toEqual(['14px', '22px']);
    expect(comment.body).toEqual(['15px', '26px']);
    expect(comment.metrics).toEqual(['13px', '20px']);
    expect(comment.badge).toEqual(['12px', '20px']);

    // 楼中楼返回控件与详情返回控件同样式，卡片与评论区左右边缘对齐。
    await page.goto(`/dynamics/${mainDynamicId}/comments/${rootWithReplies}`);
    await expect(page.getByRole('button', { name: '返回评论' })).toBeVisible();
    await expect(page.locator('.thread-root')).toBeVisible();
    const thread = await page.evaluate(() => {
      const back = document.querySelector<HTMLElement>('.thread-back')!;
      const nickname = document.querySelector<HTMLElement>('.thread-nickname')!;
      const badge = document.querySelector<HTMLElement>('.thread-badge')!;
      const body = document.querySelector<HTMLElement>('.thread-root__text')!;
      const style = (node: Element) => getComputedStyle(node);
      return {
        backFont: style(back).fontSize,
        backLine: style(back).lineHeight,
        backWeight: style(back).fontWeight,
        backHeight: Math.round(back.getBoundingClientRect().height),
        nicknameFont: style(nickname).fontSize,
        nicknameLine: style(nickname).lineHeight,
        badgeFont: style(badge).fontSize,
        badgeLine: style(badge).lineHeight,
        bodyFont: style(body).fontSize,
        bodyLine: style(body).lineHeight,
      };
    });
    expect(thread.backFont).toBe('14px');
    expect(thread.backLine).toBe('22px');
    expect(thread.backWeight).toBe('400');
    expect(thread.backHeight).toBeGreaterThanOrEqual(44);
    expect(thread.nicknameFont).toBe('14px');
    expect(thread.nicknameLine).toBe('22px');
    expect(thread.badgeFont).toBe('12px');
    expect(thread.badgeLine).toBe('20px');
    expect(thread.bodyFont).toBe('15px');
    expect(thread.bodyLine).toBe('26px');
  });

  test('详情直达与刷新重新读取，不存在与失败分别表达', async ({ page }) => {
    const first = '90071992547409931';
    await page.goto(`/dynamics/${first}`);
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect(page.getByRole('article')).toContainText('今天把小小的想法写在这里');
    await page.reload();
    await expect(page.getByRole('article')).toContainText('今天把小小的想法写在这里');

    await page.goto('/dynamics/123');
    await expect(page.getByText('动态不存在或不可用')).toBeVisible();
    await expect(page.getByRole('button', { name: '重试' })).toHaveCount(0);
    await page.getByRole('button', { name: '‹ 动态列表' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: '全部动态' })).toBeVisible();
  });
});
