import type { Page } from '@playwright/test';

// Chromium 原生 touch 输入，交由浏览器产生 PointerEvent 与纵向滚动；不替代真机。
export async function swipePreview(page: Page, dx: number, dy: number) {
  const stage = (await page.getByRole('region', { name: '预览图片阅读区域' }).boundingBox())!;
  const x = stage.x + stage.width / 2;
  const y = stage.y + stage.height / 2;
  const input = await page.context().newCDPSession(page);
  await input.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let step = 1; step <= 10; step++) {
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10, id: 1 }] });
    await page.waitForTimeout(20); // 原生触摸连续输入帧，不用固定等待猜测断言结果。
  }
  await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await input.detach();
}
