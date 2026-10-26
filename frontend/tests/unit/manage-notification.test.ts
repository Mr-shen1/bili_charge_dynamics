import { cleanup, fireEvent, screen, waitFor } from '@testing-library/vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReader } from '../support/reader';
import { showApp } from '../support/app';
import { createManagement } from '../support/management';
import type { ManagementResult, NotificationState } from '../../src/manage/managementApi';

type Update = (request: { enabled: boolean; signal: AbortSignal }) => Promise<ManagementResult<NotificationState>>;

afterEach(cleanup);

const reader = createReader();

/** 列表读取恒成功：本文件只观察页顶部的飞书通知开关，UP 列表不是被测对象。 */
function manage(overrides: Parameters<typeof createManagement>[0] = {}) {
  return createManagement({ listUps: async () => ({ status: 'success', data: [] }), ...overrides });
}

function toggleButton(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

describe('/manage 飞书通知总开关', () => {
  it('初始状态来自接口，不读本地记忆：显示运行中与待发条数', async () => {
    const readNotification = vi.fn(async () => ({
      status: 'success' as const, data: { enabled: true, pending: 3 },
    }));
    await showApp(reader, '/manage', undefined, manage({ readNotification }));
    expect(await screen.findByText('飞书通知：运行中，待发 3 条。')).toBeTruthy();
    expect(readNotification).toHaveBeenCalledTimes(1);
    expect(toggleButton('关闭飞书通知').getAttribute('aria-pressed')).toBe('true');
  });

  it('切换提交完整 {enabled:false}，并用后端返回的新状态刷新页面', async () => {
    const updateNotification = vi.fn<Update>(async () => ({
      status: 'success', data: { enabled: false, pending: 4 },
    }));
    await showApp(reader, '/manage', undefined, manage({
      readNotification: async () => ({ status: 'success', data: { enabled: true, pending: 0 } }),
      updateNotification,
    }));
    await fireEvent.click(await screen.findByRole('button', { name: '关闭飞书通知' }));
    await waitFor(() => expect(updateNotification).toHaveBeenCalledTimes(1));
    expect(updateNotification.mock.calls[0]![0].enabled).toBe(false);
    expect(await screen.findByText('飞书通知：已关闭，待发 4 条。')).toBeTruthy();
    expect(toggleButton('开启飞书通知').getAttribute('aria-pressed')).toBe('false');
    expect((await screen.findByRole('alert')).textContent).toContain('飞书通知已关闭');
  });

  it('切换失败保留原状态并给固定提示，不本地翻转', async () => {
    const updateNotification = vi.fn<Update>(async () => ({
      status: 'error', message: '配置存储暂不可用，请重试。',
    }));
    await showApp(reader, '/manage', undefined, manage({
      readNotification: async () => ({ status: 'success', data: { enabled: true, pending: 2 } }),
      updateNotification,
    }));
    await fireEvent.click(await screen.findByRole('button', { name: '关闭飞书通知' }));
    expect((await screen.findByRole('alert')).textContent).toContain('配置存储暂不可用，请重试。');
    expect(screen.getByText('飞书通知：运行中，待发 2 条。')).toBeTruthy();
    expect(toggleButton('关闭飞书通知').getAttribute('aria-pressed')).toBe('true');
    // 失败不锁死后续切换：恢复后再点仍能提交。
    updateNotification.mockResolvedValueOnce({ status: 'success', data: { enabled: false, pending: 2 } });
    await fireEvent.click(toggleButton('关闭飞书通知'));
    expect(await screen.findByText('飞书通知：已关闭，待发 2 条。')).toBeTruthy();
  });

  it('切换进行中不重复提交', async () => {
    let resolve: (value: ManagementResult<NotificationState>) => void = () => {};
    const updateNotification = vi.fn<Update>(() => new Promise(resolve_ => { resolve = resolve_; }));
    await showApp(reader, '/manage', undefined, manage({
      readNotification: async () => ({ status: 'success', data: { enabled: true, pending: 0 } }),
      updateNotification,
    }));
    await fireEvent.click(await screen.findByRole('button', { name: '关闭飞书通知' }));
    // 提交中按钮显示进度且不可再点：重复点击不能穿透到服务端。
    const busy = await screen.findByRole('button', { name: '正在提交…' });
    await fireEvent.click(busy);
    await fireEvent.click(busy);
    resolve({ status: 'success', data: { enabled: false, pending: 0 } });
    await waitFor(() => expect(screen.getByText('飞书通知：已关闭，待发 0 条。')).toBeTruthy());
    expect(updateNotification).toHaveBeenCalledTimes(1);
  });

  it('读取失败显示固定提示，原位重试后按真实状态渲染', async () => {
    const readNotification = vi.fn()
      .mockResolvedValueOnce({ status: 'error', message: '管理接口响应异常，请重试。' })
      .mockResolvedValueOnce({ status: 'success', data: { enabled: false, pending: 7 } });
    await showApp(reader, '/manage', undefined, manage({ readNotification }));
    expect((await screen.findByRole('alert')).textContent).toContain('管理接口响应异常，请重试。');
    await fireEvent.click(screen.getByRole('button', { name: '重新读取通知开关' }));
    expect(await screen.findByText('飞书通知：已关闭，待发 7 条。')).toBeTruthy();
    expect(readNotification).toHaveBeenCalledTimes(2);
  });
});
