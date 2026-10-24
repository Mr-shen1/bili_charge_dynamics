import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReader } from '../support/reader';
import { settle, showApp } from '../support/app';
import { deferred } from '../support/reader';
import { createManagement, managementUp } from '../support/management';

afterEach(cleanup);

const reader = createReader();

async function upCard(uid: string) {
  return within(await screen.findByRole('article', { name: `UP ${uid}` }));
}

describe('/manage/ups/:upId 单 UP 管理页', () => {
  it('读取后展示身份、UID 与监控状态，启停使用已保存配置', async () => {
    const updateMonitor = vi.fn(async () => ({ status: 'success' as const,
      data: managementUp('123', { monitor: { mode: 'recent', recentN: 10, enabled: false,
        lastCheckedAt: null, lastSucceededAt: null } }) }));
    await showApp(reader, '/manage/ups/123', undefined, createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123'), managementUp('456')] }),
      updateMonitor,
    }));
    const card = await upCard('123');
    expect(card.getByText('用户 123')).toBeTruthy();
    expect(card.getByText('UID：123')).toBeTruthy();
    expect(card.getByText('监控：已启用')).toBeTruthy();
    expect(card.getByRole('img', { name: '用户 123的头像' })).toBeTruthy();

    await fireEvent.click(card.getByRole('button', { name: '停止监控' }));
    await waitFor(() => expect(card.getByText('监控：已停止')).toBeTruthy());
    expect(updateMonitor).toHaveBeenCalledTimes(1);
    expect(updateMonitor).toHaveBeenCalledWith(expect.objectContaining({
      uid: '123',
      monitor: { mode: 'recent', recentN: 10, enabled: false },
    }));
    expect(card.getByText('启停已保存。')).toBeTruthy();
    expect(card.getByRole('button', { name: '启用监控' })).toBeTruthy();
  });

  it('启停失败保持已保存状态并原位重试，重复写入被阻止', async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createManagement>['updateMonitor']>>>();
    const updateMonitor = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ status: 'success' as const,
        data: managementUp('123', { monitor: { mode: 'recent', recentN: 10, enabled: false,
          lastCheckedAt: null, lastSucceededAt: null } }) });
    await showApp(reader, '/manage/ups/123', undefined, createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      updateMonitor,
    }));
    const card = await upCard('123');
    await fireEvent.click(card.getByRole('button', { name: '停止监控' }));
    expect((card.getByRole('button', { name: '正在停止…' }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(card.getByRole('button', { name: '正在停止…' }));
    expect(updateMonitor).toHaveBeenCalledTimes(1);

    pending.resolve({ status: 'error', message: '管理服务暂不可用，请重试。' });
    expect((await card.findByRole('alert')).textContent).toContain('管理服务暂不可用');
    expect(card.getByText('监控：已启用')).toBeTruthy();
    expect(card.queryByText('启停已保存。')).toBeNull();

    await fireEvent.click(card.getByRole('button', { name: '重试停止' }));
    await waitFor(() => expect(card.getByText('监控：已停止')).toBeTruthy());
    expect(updateMonitor).toHaveBeenCalledTimes(2);
  });

  it('离开页面后旧启停的迟到失败不改写新的访问', async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createManagement>['updateMonitor']>>>();
    const updateMonitor = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ status: 'error' as const, message: '管理服务暂不可用，请重试。' });
    const router = await showApp(reader, '/manage/ups/123', undefined, createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      updateMonitor,
    }));
    await fireEvent.click((await upCard('123')).getByRole('button', { name: '停止监控' }));
    await settle();
    await router.push('/manage');
    await settle();
    await router.push('/manage/ups/123');
    await settle();
    expect((await upCard('123')).getByText('监控：已启用')).toBeTruthy();

    pending.resolve({ status: 'error', message: '管理服务暂不可用，请重试。' });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect((await upCard('123')).getByText('监控：已启用')).toBeTruthy();
    expect((await upCard('123')).getByRole('button', { name: '停止监控' })).toBeTruthy();
  });

  it('跨 UP 的迟到成功不改写当前卡片的身份与状态', async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createManagement>['updateMonitor']>>>();
    const updateMonitor = vi.fn(() => pending.promise);
    const router = await showApp(reader, '/manage/ups/123', undefined, createManagement({
      listUps: async () => ({ status: 'success', data: [
        managementUp('123'),
        managementUp('456', { monitor: { mode: 'recent', recentN: 10, enabled: false,
          lastCheckedAt: null, lastSucceededAt: null } }),
      ] }),
      updateMonitor,
    }));
    await fireEvent.click((await upCard('123')).getByRole('button', { name: '停止监控' }));
    await settle();
    await router.push('/manage/ups/456');
    await settle();
    expect((await upCard('456')).getByText('监控：已停止')).toBeTruthy();

    pending.resolve({ status: 'success', data: managementUp('123') });
    await settle();
    const card = await upCard('456');
    expect(card.queryByText('启停已保存。')).toBeNull();
    expect(card.queryByRole('alert')).toBeNull();
    expect(card.getByText('监控：已停止')).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'UP 123' })).toBeNull();
  });

  it('读取失败可原位重试，UP 不存在时提示并可回到列表', async () => {
    const listUps = vi.fn()
      .mockResolvedValueOnce({ status: 'error' as const, message: '配置存储暂不可用，请重试。' })
      .mockResolvedValue({ status: 'success' as const, data: [managementUp('456')] });
    await showApp(reader, '/manage/ups/123', undefined, createManagement({ listUps }));
    expect((await screen.findByRole('alert')).textContent).toContain('配置存储暂不可用');
    await fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByText('未找到该 UP，可能已被删除。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '返回 UP 列表' })).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
    expect(listUps).toHaveBeenCalledTimes(2);
  });

  it('已删除的配置仍展示身份与归档保留说明，且不提供启停', async () => {
    await showApp(reader, '/manage/ups/789', undefined, createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('789', { monitor: null })] }),
    }));
    const card = await upCard('789');
    expect(card.getByText('监控：无配置')).toBeTruthy();
    expect(card.getByText(/已有归档/)).toBeTruthy();
    expect(card.queryByRole('button', { name: /监控$/ })).toBeNull();
  });

  it('401 只显示固定身份验证提示，且不发启停请求', async () => {
    const updateMonitor = vi.fn();
    await showApp(reader, '/manage/ups/123', undefined, createManagement({
      listUps: async () => ({ status: 'error', message: '管理访问需要身份验证，请刷新页面重新认证。' }),
      updateMonitor,
    }));
    expect((await screen.findByRole('alert')).textContent).toContain('管理访问需要身份验证');
    expect(screen.getByRole('link', { name: '返回阅读' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '停止监控' })).toBeNull();
    expect(updateMonitor).not.toHaveBeenCalled();
  });
});
