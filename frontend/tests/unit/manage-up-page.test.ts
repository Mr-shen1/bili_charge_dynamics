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
    expect(card.getByText(/已保存的动态/)).toBeTruthy();
    // 无配置时不提供启停，但可按基线重新添加监控。
    expect(card.queryByRole('button', { name: /^(停止|启用)监控$/ })).toBeNull();
    expect(card.queryByRole('button', { name: '删除监控配置' })).toBeNull();
    expect(card.getByRole('button', { name: '重新添加监控' })).toBeTruthy();
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

describe('/manage/ups/:upId 监控模式与近期 N', () => {
  async function ready(management: ReturnType<typeof createManagement>, uid = '123') {
    await showApp(reader, `/manage/ups/${uid}`, undefined, management);
    return upCard(uid);
  }

  it('表单按已保存配置展示，保存提交完整配置并保留启停状态', async () => {
    const updateMonitor = vi.fn(async () => ({ status: 'success' as const,
      data: managementUp('123', { monitor: { mode: 'recent', recentN: 25, enabled: true,
        lastCheckedAt: null, lastSucceededAt: null } }) }));
    const card = await ready(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      updateMonitor,
    }));
    expect(card.getByText('已保存模式：近期 N 条；N：10。')).toBeTruthy();
    const recentN = card.getByRole('textbox', { name: '近期 N 条' }) as HTMLInputElement;
    expect(recentN.value).toBe('10');

    await fireEvent.update(recentN, '25');
    await fireEvent.click(card.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(card.getByText('已保存模式：近期 N 条；N：25。')).toBeTruthy());
    expect(updateMonitor).toHaveBeenCalledWith(expect.objectContaining({
      uid: '123', monitor: { mode: 'recent', recentN: 25, enabled: true },
    }));
    expect(card.getByText('保存成功。')).toBeTruthy();
  });

  it('近期 N 本地校验失败不发请求，草稿保留并原位重试', async () => {
    const updateMonitor = vi.fn(async () => ({ status: 'success' as const, data: managementUp('123') }));
    const card = await ready(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      updateMonitor,
    }));
    const recentN = card.getByRole('textbox', { name: '近期 N 条' }) as HTMLInputElement;
    for (const value of ['0', '0123', '1e3', '1.5', '9'.repeat(17)]) {
      await fireEvent.update(recentN, value);
      await fireEvent.click(card.getByRole('button', { name: /保存配置|重试保存/ }));
      expect((await card.findByRole('alert')).textContent).toContain('近期 N 须为正的安全整数');
      expect(recentN.value).toBe(value);
    }
    expect(updateMonitor).not.toHaveBeenCalled();
  });

  it('模式互斥：切到指定模式隐藏近期 N，保存提交指定模式', async () => {
    const updateMonitor = vi.fn(async () => ({ status: 'success' as const,
      data: managementUp('123', { monitor: { mode: 'specified', recentN: 10, enabled: true,
        lastCheckedAt: null, lastSucceededAt: null } }) }));
    const card = await ready(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      updateMonitor,
      listTargets: async () => ({ status: 'success', data: [] }),
    }));
    await fireEvent.click(card.getByRole('radio', { name: '指定动态 ID' }));
    expect(card.queryByRole('textbox', { name: '近期 N 条' })).toBeNull();
    expect(card.getByRole('region', { name: '指定动态目标' })).toBeTruthy();

    await fireEvent.click(card.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(card.getByText('已保存模式：指定动态 ID。')).toBeTruthy());
    expect(updateMonitor).toHaveBeenCalledWith(expect.objectContaining({
      monitor: { mode: 'specified', recentN: 10, enabled: true },
    }));
  });

  it('保存失败保留草稿并与已保存模式区分，可原位重试', async () => {
    const updateMonitor = vi.fn()
      .mockResolvedValueOnce({ status: 'error' as const, message: '配置存储暂不可用，请重试。' })
      .mockResolvedValueOnce({ status: 'success' as const, data: managementUp('123',
        { monitor: { mode: 'recent', recentN: 42, enabled: true, lastCheckedAt: null, lastSucceededAt: null } }) });
    const card = await ready(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      updateMonitor,
    }));
    await fireEvent.update(card.getByRole('textbox', { name: '近期 N 条' }), '42');
    await fireEvent.click(card.getByRole('button', { name: '保存配置' }));
    expect((await card.findByRole('alert')).textContent).toContain('配置存储暂不可用');
    expect(card.getByText('已保存模式：近期 N 条；N：10。')).toBeTruthy();
    expect((card.getByRole('textbox', { name: '近期 N 条' }) as HTMLInputElement).value).toBe('42');

    await fireEvent.click(card.getByRole('button', { name: '重试保存' }));
    await waitFor(() => expect(card.getByText('已保存模式：近期 N 条；N：42。')).toBeTruthy());
    expect(updateMonitor).toHaveBeenCalledTimes(2);
  });

  it('草稿按 UP 与模式隔离：换 UP 或往返模式后不沿用上一份草稿与反馈', async () => {
    const router = await showApp(reader, '/manage/ups/123', undefined, createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123'), managementUp('456', {
        monitor: { mode: 'recent', recentN: 30, enabled: true, lastCheckedAt: null, lastSucceededAt: null },
      })] }),
      listTargets: async () => ({ status: 'error', message: '管理接口响应异常，请重试。' }),
    }));
    const first = await upCard('123');
    await fireEvent.update(first.getByRole('textbox', { name: '近期 N 条' }), '99');
    await fireEvent.click(first.getByRole('radio', { name: '指定动态 ID' }));
    expect((await first.findByRole('alert')).textContent).toContain('管理接口响应异常');

    await router.push('/manage/ups/456');
    await settle();
    const second = await upCard('456');
    expect((second.getByRole('textbox', { name: '近期 N 条' }) as HTMLInputElement).value).toBe('30');
    expect(second.queryByRole('alert')).toBeNull();

    await router.push('/manage/ups/123');
    await settle();
    const again = await upCard('123');
    expect((again.getByRole('textbox', { name: '近期 N 条' }) as HTMLInputElement).value).toBe('10');
    expect(again.queryByRole('textbox', { name: '动态 ID' })).toBeNull();
    expect(again.queryByRole('alert')).toBeNull();
  });
});

describe('/manage/ups/:upId 删除配置与指定目标', () => {
  async function ready(management: ReturnType<typeof createManagement>, uid = '123') {
    await showApp(reader, `/manage/ups/${uid}`, undefined, management);
    return upCard(uid);
  }

  async function specified(management: ReturnType<typeof createManagement>) {
    const card = await ready(management);
    await fireEvent.click(card.getByRole('radio', { name: '指定动态 ID' }));
    return card;
  }

  it('删除监控配置只删配置：身份与归档保留，可重新添加回默认配置', async () => {
    const deleteMonitor = vi.fn(async () => ({ status: 'success' as const, data: undefined }));
    const addUp = vi.fn(async () => ({ status: 'success' as const,
      data: managementUp('123', { monitor: { mode: 'recent', recentN: 10, enabled: false,
        lastCheckedAt: null, lastSucceededAt: null } }) }));
    const card = await ready(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      deleteMonitor,
      addUp,
    }));
    await fireEvent.click(card.getByRole('button', { name: '删除监控配置' }));
    expect(deleteMonitor).toHaveBeenCalledTimes(1);
    // 配置存在性变化会重建卡片：每次都重新查询页面，避免作用在已卸载的节点上。
    await waitFor(() => expect(screen.getByText('配置已删除')).toBeTruthy());
    expect(screen.getByText('监控：无配置')).toBeTruthy();
    expect(screen.getByText('暂无监控配置，重新添加后可编辑。')).toBeTruthy();
    expect(screen.getByText('监控配置已删除；身份和已保存的动态保留。')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '近期 N 条' })).toBeNull();
    expect(deleteMonitor).toHaveBeenCalledWith(expect.objectContaining({ uid: '123' }));

    await fireEvent.click(screen.getByRole('button', { name: '重新添加监控' }));
    await waitFor(() => expect(screen.getByText('监控：已停止')).toBeTruthy());
    expect(addUp).toHaveBeenCalledWith(expect.objectContaining({ uid: '123' }));
    expect((screen.getByRole('textbox', { name: '近期 N 条' }) as HTMLInputElement).value).toBe('10');
  });

  it('删除失败保留已保存配置并原位重试', async () => {
    const deleteMonitor = vi.fn()
      .mockResolvedValueOnce({ status: 'error' as const, message: '管理服务暂不可用，请重试。' })
      .mockResolvedValueOnce({ status: 'success' as const, data: undefined });
    const card = await ready(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      deleteMonitor,
    }));
    await fireEvent.click(card.getByRole('button', { name: '删除监控配置' }));
    expect((await card.findByRole('alert')).textContent).toContain('管理服务暂不可用');
    expect(card.getByText('已保存模式：近期 N 条；N：10。')).toBeTruthy();
    await fireEvent.click(card.getByRole('button', { name: '重试删除' }));
    expect(await screen.findByText('监控配置已删除；身份和已保存的动态保留。')).toBeTruthy();
    expect(deleteMonitor).toHaveBeenCalledTimes(2);
  });

  it('指定模式读取关联目标，添加区分正确、不符与未知并保留输入', async () => {
    const addTarget = vi.fn()
      .mockResolvedValueOnce({ status: 'success' as const, data: { id: '999' } })
      .mockResolvedValueOnce({ status: 'error' as const, message: '动态作者与所选 UP 不符。' })
      .mockResolvedValueOnce({ status: 'error' as const, message: '无法确认动态归属。' });
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets: async () => ({ status: 'success', data: [{ id: '1000' }] }),
      addTarget,
    }));
    expect(await card.findByText('1000')).toBeTruthy();

    const input = card.getByRole('textbox', { name: '动态 ID' }) as HTMLInputElement;
    await fireEvent.update(input, '999');
    await fireEvent.submit(input.closest('form')!);
    expect(await card.findByText('归属校验通过，目标关联已保存。')).toBeTruthy();
    expect(input.value).toBe('');
    const items = within(card.getByRole('list', { name: '指定动态目标列表' })).getAllByRole('listitem');
    expect(items.map(item => within(item).getByText(/^\d+$/).textContent)).toEqual(['1000', '999']);

    await fireEvent.update(input, '888');
    await fireEvent.submit(input.closest('form')!);
    expect((await card.findByRole('alert')).textContent).toContain('动态作者与所选 UP 不符');
    expect(input.value).toBe('888');

    await fireEvent.update(input, '777');
    await fireEvent.submit(input.closest('form')!);
    expect((await card.findByRole('alert')).textContent).toContain('无法确认动态归属');
    expect(input.value).toBe('777');
    expect(addTarget).toHaveBeenCalledWith(expect.objectContaining({ uid: '123', id: '777' }));
  });

  it('动态 ID 与 UID 一样按字符串校验，非法输入不发请求', async () => {
    const addTarget = vi.fn();
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets: async () => ({ status: 'success', data: [] }),
      addTarget,
    }));
    const input = await card.findByRole('textbox', { name: '动态 ID' }) as HTMLInputElement;
    for (const value of ['0123', '1e3', ' 123', '9'.repeat(129), '']) {
      await fireEvent.update(input, value);
      await fireEvent.submit(input.closest('form')!);
      expect((await card.findByRole('alert')).textContent).toContain('动态 ID 须为');
      expect(input.value).toBe(value);
    }
    expect(addTarget).not.toHaveBeenCalled();
    expect(card.getByText('尚未添加指定目标。')).toBeTruthy();
  });

  it('移除目标只解除关联并给正确反馈', async () => {
    const deleteTarget = vi.fn(async () => ({ status: 'success' as const, data: undefined }));
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets: async () => ({ status: 'success', data: [{ id: '1000' }, { id: '1001' }] }),
      deleteTarget,
    }));
    await fireEvent.click(await card.findByRole('button', { name: '移除目标 1000' }));
    expect(await card.findByText('目标已移除；已保存的动态保留。')).toBeTruthy();
    expect(card.queryByText('1000')).toBeNull();
    expect(card.getByText('1001')).toBeTruthy();
    expect(deleteTarget).toHaveBeenCalledWith(expect.objectContaining({ uid: '123', id: '1000' }));
  });

  it('目标读取失败只影响该区域并原位重试', async () => {
    const listTargets = vi.fn()
      .mockResolvedValueOnce({ status: 'error' as const, message: '配置存储暂不可用，请重试。' })
      .mockResolvedValueOnce({ status: 'success' as const, data: [{ id: '1000' }] });
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets,
    }));
    expect((await card.findByRole('alert')).textContent).toContain('配置存储暂不可用');
    expect(card.getByRole('button', { name: '保存配置' })).toBeTruthy();
    await fireEvent.click(card.getByRole('button', { name: '重试读取目标' }));
    expect(await card.findByText('1000')).toBeTruthy();
    expect(listTargets).toHaveBeenCalledTimes(2);
  });

  it('写入同步抛错后释放该 UP 的写锁，可原位重试而不是永久停在在途状态', async () => {
    // 真机基线 iOS 16.4 缺 AbortSignal.any：早期实现在写请求前组合信号，同步抛错，
    // 而写锁没有 finally 释放，于是按钮永久停在「正在校验…」且同一 UP 的后续写入全被挡掉。
    const addTarget = vi.fn()
      .mockImplementationOnce(() => {
        throw new TypeError('AbortSignal.any is not a function');
      })
      .mockResolvedValueOnce({ status: 'success' as const, data: { id: '999' } });
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets: async () => ({ status: 'success', data: [] }),
      addTarget,
    }));
    const input = await card.findByRole('textbox', { name: '动态 ID' }) as HTMLInputElement;
    await fireEvent.update(input, '999');
    await fireEvent.submit(input.closest('form')!);

    // 异常必须变成可见的失败反馈，而不是把写入锁留在这个 UP 上：按钮回到可点的重试态。
    expect((await card.findByRole('alert')).textContent).toContain('管理接口响应异常');
    const retry = card.getByRole('button', { name: '重试添加目标' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(input.value).toBe('999');

    await fireEvent.submit(input.closest('form')!);
    expect(await card.findByText('归属校验通过，目标关联已保存。')).toBeTruthy();
    expect(addTarget).toHaveBeenCalledTimes(2);
  });

  it('移除目标同步抛错同样释放写锁，随后可移除其他目标', async () => {
    const deleteTarget = vi.fn()
      .mockImplementationOnce(() => {
        throw new TypeError('AbortSignal.any is not a function');
      })
      .mockResolvedValueOnce({ status: 'success' as const, data: undefined });
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets: async () => ({ status: 'success', data: [{ id: '1000' }, { id: '1001' }] }),
      deleteTarget,
    }));
    await fireEvent.click(await card.findByRole('button', { name: '移除目标 1000' }));
    expect((await card.findByRole('alert')).textContent).toContain('管理接口响应异常');
    expect((card.getByRole('button', { name: '移除目标 1001' }) as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.click(card.getByRole('button', { name: '移除目标 1001' }));
    expect(await card.findByText('目标已移除；已保存的动态保留。')).toBeTruthy();
    expect(deleteTarget).toHaveBeenCalledTimes(2);
  });

  it('同一 UP 的写入串行：目标添加在途时其他写入与重复提交被阻止', async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createManagement>['addTarget']>>>();
    const addTarget = vi.fn(() => pending.promise);
    const updateMonitor = vi.fn();
    const deleteMonitor = vi.fn();
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets: async () => ({ status: 'success', data: [] }),
      addTarget, updateMonitor, deleteMonitor,
    }));
    const input = card.getByRole('textbox', { name: '动态 ID' }) as HTMLInputElement;
    await fireEvent.update(input, '999');
    await fireEvent.submit(input.closest('form')!);
    expect((card.getByRole('button', { name: '正在校验…' }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.submit(input.closest('form')!);
    expect(addTarget).toHaveBeenCalledTimes(1);
    expect((card.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(true);
    expect((card.getByRole('button', { name: '停止监控' }) as HTMLButtonElement).disabled).toBe(true);
    expect((card.getByRole('button', { name: '删除监控配置' }) as HTMLButtonElement).disabled).toBe(true);

    pending.resolve({ status: 'success', data: { id: '999' } });
    expect(await card.findByText('归属校验通过，目标关联已保存。')).toBeTruthy();
    expect(updateMonitor).not.toHaveBeenCalled();
    expect(deleteMonitor).not.toHaveBeenCalled();
  });

  it('切换模式卸载目标区：旧请求迟到成功不改写当前模式与反馈', async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createManagement>['addTarget']>>>();
    const addTarget = vi.fn(() => pending.promise);
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets: async () => ({ status: 'success', data: [] }),
      addTarget,
    }));
    const input = card.getByRole('textbox', { name: '动态 ID' }) as HTMLInputElement;
    await fireEvent.update(input, '999');
    await fireEvent.submit(input.closest('form')!);

    await fireEvent.click(card.getByRole('radio', { name: '近期 N 条' }));
    expect(card.queryByRole('textbox', { name: '动态 ID' })).toBeNull();
    pending.resolve({ status: 'success', data: { id: '999' } });
    await settle();
    expect(card.queryByText('归属校验通过，目标关联已保存。')).toBeNull();
    expect(card.queryByRole('alert')).toBeNull();
    expect(card.getByText('已保存模式：近期 N 条；N：10。')).toBeTruthy();

    await fireEvent.click(card.getByRole('radio', { name: '指定动态 ID' }));
    expect(await card.findByText('尚未添加指定目标。')).toBeTruthy();
    expect(card.queryByText('归属校验通过，目标关联已保存。')).toBeNull();
  });
});

describe('/manage/ups/:upId 目标写入的反馈与取消', () => {
  async function specified(management: ReturnType<typeof createManagement>) {
    await showApp(reader, '/manage/ups/123', undefined, management);
    const card = within(await screen.findByRole('article', { name: 'UP 123' }));
    await fireEvent.click(card.getByRole('radio', { name: '指定动态 ID' }));
    return card;
  }

  it('移除失败只影响移除本身：添加按钮不变成重试添加，同按钮可重试移除', async () => {
    const deleteTarget = vi.fn()
      .mockResolvedValueOnce({ status: 'error' as const, message: '管理服务暂不可用，请重试。' })
      .mockResolvedValueOnce({ status: 'success' as const, data: undefined });
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets: async () => ({ status: 'success', data: [{ id: '1000' }] }),
      deleteTarget,
    }));
    await fireEvent.click(await card.findByRole('button', { name: '移除目标 1000' }));
    expect((await card.findByRole('alert')).textContent).toContain('管理服务暂不可用');
    expect(card.getByRole('button', { name: '校验并添加目标' })).toBeTruthy();
    expect(card.queryByRole('button', { name: '重试添加目标' })).toBeNull();
    expect(card.getByRole('button', { name: '移除目标 1000' })).toBeTruthy();

    await fireEvent.click(card.getByRole('button', { name: '移除目标 1000' }));
    await waitFor(() => expect(card.queryByText('1000')).toBeNull());
    expect(deleteTarget).toHaveBeenCalledTimes(2);
  });

  it('添加失败后添加按钮给重试入口', async () => {
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets: async () => ({ status: 'success', data: [] }),
      addTarget: async () => ({ status: 'error', message: '无法确认动态归属。' }),
    }));
    const input = (await card.findByRole('textbox', { name: '动态 ID' })) as HTMLInputElement;
    await fireEvent.update(input, '999');
    await fireEvent.submit(input.closest('form')!);
    expect((await card.findByRole('alert')).textContent).toContain('无法确认动态归属');
    expect(card.getByRole('button', { name: '重试添加目标' })).toBeTruthy();
  });

  it('切换模式会取消在途的目标写入，旧结果不再落到新页面', async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createManagement>['addTarget']>>>();
    const signals: AbortSignal[] = [];
    const addTarget = vi.fn((options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return pending.promise;
    });
    const card = await specified(createManagement({
      listUps: async () => ({ status: 'success', data: [managementUp('123')] }),
      listTargets: async () => ({ status: 'success', data: [] }),
      addTarget,
    }));
    const input = (await card.findByRole('textbox', { name: '动态 ID' })) as HTMLInputElement;
    await fireEvent.update(input, '999');
    await fireEvent.submit(input.closest('form')!);
    expect(signals[0]!.aborted).toBe(false);

    await fireEvent.click(card.getByRole('radio', { name: '近期 N 条' }));
    expect(signals[0]!.aborted).toBe(true);
    pending.resolve({ status: 'success', data: { id: '999' } });
    await settle();
    expect(card.queryByText('归属校验通过，目标关联已保存。')).toBeNull();
    expect(card.getByText('已保存模式：近期 N 条；N：10。')).toBeTruthy();
  });
});
