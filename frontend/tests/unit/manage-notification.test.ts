import { cleanup, fireEvent, screen, waitFor } from '@testing-library/vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReader } from '../support/reader';
import { showApp } from '../support/app';
import { createManagement } from '../support/management';
import type { ManagementResult, NotificationMode, NotificationState } from '../../src/manage/managementApi';

type Update = (request: { state: NotificationMode; signal: AbortSignal }) => Promise<ManagementResult<NotificationState>>;

afterEach(cleanup);

const reader = createReader();

/** 列表读取恒成功：本文件只观察页顶部的飞书通知状态，UP 列表不是被测对象。 */
function manage(overrides: Parameters<typeof createManagement>[0] = {}) {
  return createManagement({ listUps: async () => ({ status: 'success', data: [] }), ...overrides });
}

/** 三态选择器只有一个：按可访问名字取，避免依赖内部 DOM。 */
function selector(): HTMLElement {
  return screen.getByLabelText('飞书通知状态');
}

/** Element Plus 的下拉在测试环境里以原生 select 语义暴露选项时直接选值。 */
async function choose(value: NotificationMode): Promise<void> {
  await fireEvent.update(selector(), value);
}

describe('/manage 飞书通知三态', () => {
  it('初始状态来自接口，不读本地记忆：显示状态与待发条数', async () => {
    const readNotification = vi.fn(async () => ({
      status: 'success' as const, data: { state: 'all' as const, pending: 3 },
    }));
    await showApp(reader, '/manage', undefined, manage({ readNotification }));
    expect(await screen.findByText('飞书通知：全部通知，待发 3 条。')).toBeTruthy();
    expect(readNotification).toHaveBeenCalledTimes(1);
    expect((selector() as HTMLInputElement).value).toBe('all');
  });

  it('默认状态是全部关闭，并提示不补发', async () => {
    await showApp(reader, '/manage', undefined, manage({
      readNotification: async () => ({ status: 'success', data: { state: 'off', pending: 0 } }),
    }));
    expect(await screen.findByText('飞书通知：全部关闭，待发 0 条。')).toBeTruthy();
    expect(screen.getByText(/一条飞书消息都不发/)).toBeTruthy();
    expect(screen.getByText(/关闭或仅系统期间发生的变化不会补发/)).toBeTruthy();
  });

  it('切换提交完整 {state}，并用后端返回的新状态刷新页面', async () => {
    const updateNotification = vi.fn<Update>(async () => ({
      status: 'success', data: { state: 'system_only', pending: 4 },
    }));
    await showApp(reader, '/manage', undefined, manage({
      readNotification: async () => ({ status: 'success', data: { state: 'all', pending: 0 } }),
      updateNotification,
    }));
    await choose('system_only');
    await waitFor(() => expect(updateNotification).toHaveBeenCalledTimes(1));
    expect(updateNotification.mock.calls[0]![0].state).toBe('system_only');
    expect(await screen.findByText('飞书通知：仅心跳与告警，待发 4 条。')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('飞书通知已切换为「仅心跳与告警」');
  });

  it('切换到同一状态不提交', async () => {
    const updateNotification = vi.fn<Update>();
    await showApp(reader, '/manage', undefined, manage({
      readNotification: async () => ({ status: 'success', data: { state: 'off', pending: 0 } }),
      updateNotification,
    }));
    await screen.findByText('飞书通知：全部关闭，待发 0 条。');
    await choose('off');
    expect(updateNotification).not.toHaveBeenCalled();
  });

  it('切换失败保留原状态并给固定提示，不本地翻转', async () => {
    const updateNotification = vi.fn<Update>(async () => ({
      status: 'error', message: '配置存储暂不可用，请重试。',
    }));
    await showApp(reader, '/manage', undefined, manage({
      readNotification: async () => ({ status: 'success', data: { state: 'all', pending: 2 } }),
      updateNotification,
    }));
    await choose('off');
    expect((await screen.findByRole('alert')).textContent).toContain('配置存储暂不可用，请重试。');
    expect(screen.getByText('飞书通知：全部通知，待发 2 条。')).toBeTruthy();
    expect((selector() as HTMLInputElement).value).toBe('all');
    // 失败不锁死后续切换：恢复后再选仍能提交。
    updateNotification.mockResolvedValueOnce({ status: 'success', data: { state: 'off', pending: 0 } });
    await choose('off');
    expect(await screen.findByText('飞书通知：全部关闭，待发 0 条。')).toBeTruthy();
  });

  it('读取失败显示固定提示，原位重试后按真实状态渲染', async () => {
    const readNotification = vi.fn()
      .mockResolvedValueOnce({ status: 'error', message: '管理接口响应异常，请重试。' })
      .mockResolvedValueOnce({ status: 'success', data: { state: 'system_only', pending: 7 } });
    await showApp(reader, '/manage', undefined, manage({ readNotification }));
    expect((await screen.findByRole('alert')).textContent).toContain('管理接口响应异常，请重试。');
    await fireEvent.click(screen.getByRole('button', { name: '重新读取通知状态' }));
    expect(await screen.findByText('飞书通知：仅心跳与告警，待发 7 条。')).toBeTruthy();
    expect(readNotification).toHaveBeenCalledTimes(2);
  });
});
