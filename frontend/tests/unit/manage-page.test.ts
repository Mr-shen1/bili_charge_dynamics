import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReader } from '../support/reader';
import { settle, showApp } from '../support/app';
import { deferred } from '../support/reader';
import { createManagement, managementUp } from '../support/management';

afterEach(cleanup);

const reader = createReader();

/** 在列表页填入 UID 并提交表单：与用户按回车/点按钮走同一个表单提交路径。 */
async function submitUid(uid: string) {
  const input = await screen.findByRole('textbox', { name: 'UP UID' });
  await fireEvent.update(input, uid);
  await fireEvent.submit(input.closest('form')!);
  return input;
}

function upList() {
  return screen.getByRole('list', { name: 'UP 列表' });
}

describe('/manage UP 列表页', () => {
  it('读取中先给状态，随后按 UID 展示身份与监控状态，点卡片进入单 UP 管理', async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createManagement>['listUps']>>>();
    const listUps = vi.fn(() => pending.promise);
    const router = await showApp(reader, '/manage', undefined, createManagement({ listUps }));
    expect(screen.getByText('正在读取管理配置…')).toBeTruthy();

    pending.resolve({ status: 'success', data: [
      managementUp('123'),
      managementUp('456', { name: '用户 456', monitor: { mode: 'recent', recentN: 10, enabled: false,
        lastCheckedAt: null, lastSucceededAt: null } }),
      managementUp('789', { name: null, avatarUrl: null, monitor: null }),
    ] });

    const items = within(await screen.findByRole('list', { name: 'UP 列表' })).getAllByRole('listitem');
    expect(items.map(item => item.textContent?.replace(/\s+/g, ''))).toEqual([
      '用户123UID：123监控已启用',
      '用户456UID：456监控已停止',
      '未知用户UID：789配置已删除',
    ]);
    expect(listUps).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole('link', { name: '管理 UP 123' }));
    await waitFor(() => expect(router.currentRoute.value.path).toBe("/manage/ups/123"));
  });

  it('读取失败只显示固定提示，原位重试后回到列表', async () => {
    const listUps = vi.fn()
      .mockResolvedValueOnce({ status: 'error', message: '配置存储暂不可用，请重试。' })
      .mockResolvedValueOnce({ status: 'success', data: [] });
    await showApp(reader, '/manage', undefined, createManagement({ listUps }));
    expect((await screen.findByRole('alert')).textContent).toContain('配置存储暂不可用，请重试。');
    await fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByText('尚未保存 UP，请输入 UID 添加。')).toBeTruthy();
    expect(listUps).toHaveBeenCalledTimes(2);
  });

  it('UID 校验失败不发请求：空白、前导零、科学计数与超长都保留输入', async () => {
    const addUp = vi.fn();
    await showApp(reader, '/manage', undefined,
      createManagement({ listUps: async () => ({ status: 'success', data: [] }), addUp }));
    for (const uid of [' 123', '0123', '1e3', '9'.repeat(129)]) {
      const input = await submitUid(uid);
      expect((await screen.findByRole('alert')).textContent).toContain('UID 须为');
      expect((input as HTMLInputElement).value).toBe(uid);
    }
    const input = await submitUid('');
    expect((await screen.findByRole('alert')).textContent).toContain('UID 须为');
    expect((input as HTMLInputElement).value).toBe('');
    expect(addUp).not.toHaveBeenCalled();
  });

  it('只提交字符串 UID：成功清空输入且昵称只作文字', async () => {
    const addUp = vi.fn(async () => ({ status: 'success' as const,
      data: managementUp('900719925474099312345', { name: '<img src=x onerror=alert(1)>', avatarUrl: null }) }));
    await showApp(reader, '/manage', undefined,
      createManagement({ listUps: async () => ({ status: 'success', data: [] }), addUp }));
    const input = await submitUid('900719925474099312345');
    const link = await screen.findByRole('link', { name: '管理 UP 900719925474099312345' });
    expect(addUp).toHaveBeenCalledWith(expect.objectContaining({ uid: '900719925474099312345' }));
    expect(within(link).getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText('添加成功。')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('新增失败保留输入并原位重试，失败时不显示成功提示', async () => {
    const addUp = vi.fn()
      .mockResolvedValueOnce({ status: 'error', message: '未取得 UP 资料，请重试。' })
      .mockResolvedValueOnce({ status: 'success', data: managementUp('123', { name: '', avatarUrl: '' }) });
    await showApp(reader, '/manage', undefined,
      createManagement({ listUps: async () => ({ status: 'success', data: [] }), addUp }));
    const input = await submitUid('123');
    expect((await screen.findByRole('alert')).textContent).toContain('未取得 UP 资料');
    expect((input as HTMLInputElement).value).toBe('123');
    expect(screen.queryByText('添加成功。')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: '重试添加' }));
    const link = await screen.findByRole('link', { name: '管理 UP 123' });
    expect(within(link).getByText('未知用户')).toBeTruthy();
    expect(screen.getByText('添加成功。')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('阻塞时重复提交被阻止，迟到失败只落到当前访问', async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createManagement>['addUp']>>>();
    const addUp = vi.fn(() => pending.promise);
    await showApp(reader, '/manage', undefined,
      createManagement({ listUps: async () => ({ status: 'success', data: [] }), addUp }));
    const input = await submitUid('123');
    const button = screen.getByRole('button', { name: '正在添加…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await fireEvent.submit(input.closest('form')!);
    expect(addUp).toHaveBeenCalledTimes(1);

    pending.resolve({ status: 'error', message: '该 UID 已有监控配置。' });
    expect((await screen.findByRole('alert')).textContent).toContain('该 UID 已有监控配置。');
    expect((input as HTMLInputElement).value).toBe('123');
  });

  it('离开后旧读取的迟到成功不改写新的管理访问', async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createManagement>['listUps']>>>();
    const listUps = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ status: 'success', data: [managementUp('456')] });
    const router = await showApp(reader, '/manage', undefined, createManagement({ listUps }));
    await settle();
    await router.push('/nope');
    await settle();
    await router.push('/manage');
    expect(await screen.findByRole('link', { name: '管理 UP 456' })).toBeTruthy();

    pending.resolve({ status: 'success', data: [managementUp('123')] });
    await waitFor(() => expect(screen.queryByRole('link', { name: '管理 UP 123' })).toBeNull());
    expect(screen.getByRole('link', { name: '管理 UP 456' })).toBeTruthy();
    expect(listUps).toHaveBeenCalledTimes(2);
  });

  it('401 只显示固定身份验证提示，不自动重读', async () => {
    const listUps = vi.fn(async () => ({ status: 'error' as const,
      message: '管理访问需要身份验证，请刷新页面重新认证。' }));
    await showApp(reader, '/manage', undefined, createManagement({ listUps }));
    expect((await screen.findByRole('alert')).textContent).toContain('管理访问需要身份验证');
    expect(screen.getByRole('link', { name: '返回阅读' })).toBeTruthy();
    expect(listUps).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox', { name: 'UP UID' })).toBeNull();
  });

  it('列表页不发新增之外的写请求，也不显示昵称头像编辑入口', async () => {
    const addUp = vi.fn();
    const updateMonitor = vi.fn();
    await showApp(reader, '/manage', undefined,
      createManagement({ listUps: async () => ({ status: 'success', data: [managementUp('123')] }), addUp, updateMonitor }));
    await screen.findByRole('link', { name: '管理 UP 123' });
    expect(screen.queryByLabelText(/昵称|头像|凭据/)).toBeNull();
    expect(addUp).not.toHaveBeenCalled();
    expect(updateMonitor).not.toHaveBeenCalled();
    expect(upList()).toBeTruthy();
  });
});
