import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/app/Navigation';
import { ManagePage } from '../src/manage/ManagePage';
import {
  authenticationRequiredMessage, createManagementApi,
  type ManagementApi, type ManagementResult, type ManagementTransport,
} from '../src/manage/managementApi';

const uid = '123';
const id = '456';
const monitor = { mode: 'recent', recentN: 10, enabled: true } as const;
const authError = { status: 'error', message: authenticationRequiredMessage };
const html = '<html><h1>Unauthorized</h1><p>PRIVATE_PROXY_DETAIL</p></html>';
function unauthorized() {
  return new Response(html, { status: 401, headers: { 'Content-Type': 'text/html', 'WWW-Authenticate': 'Basic realm="management"' } });
}
interface Operation {
  name: keyof ManagementApi;
  method: string;
  path: string;
  run(api: ManagementApi, signal: AbortSignal): Promise<ManagementResult<unknown>>;
}
const operations: readonly Operation[] = [
  { name: 'listUps', method: 'GET', path: '/api/manage/ups', run: (api, signal) => api.listUps({ signal }) },
  { name: 'getUp', method: 'GET', path: `/api/manage/ups/${uid}`, run: (api, signal) => api.getUp({ uid, signal }) },
  { name: 'getDiscovery', method: 'GET', path: `/api/manage/ups/${uid}/discovery`, run: (api, signal) => api.getDiscovery({ uid, signal }) },
  { name: 'listChecks', method: 'GET', path: `/api/manage/ups/${uid}/checks`, run: (api, signal) => api.listChecks({ uid, signal }) },
  { name: 'listTargets', method: 'GET', path: `/api/manage/ups/${uid}/targets`, run: (api, signal) => api.listTargets({ uid, signal }) },
  { name: 'addUp', method: 'POST', path: '/api/manage/ups', run: (api, signal) => api.addUp({ uid, signal }) },
  { name: 'addTarget', method: 'POST', path: `/api/manage/ups/${uid}/targets`, run: (api, signal) => api.addTarget({ uid, id, signal }) },
  { name: 'updateMonitor', method: 'PATCH', path: `/api/manage/ups/${uid}/monitor`, run: (api, signal) => api.updateMonitor({ uid, monitor, signal }) },
  { name: 'deleteMonitor', method: 'DELETE', path: `/api/manage/ups/${uid}/monitor`, run: (api, signal) => api.deleteMonitor({ uid, signal }) },
  { name: 'deleteTarget', method: 'DELETE', path: `/api/manage/ups/${uid}/targets/${id}`, run: (api, signal) => api.deleteTarget({ uid, id, signal }) },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('管理接口的部署入口认证', () => {
  it('固定安全文案不指向已移除的页面入口，测试表覆盖全部公开方法', () => {
    expect(authenticationRequiredMessage).toBe('管理访问需要身份验证，请刷新页面重新认证。');
    expect(operations.map(operation => operation.name).sort()).toEqual(Object.keys(createManagementApi()).sort());
  });

  it.each(operations)('$name 在 JSON 解析前处理 HTML 401，不读取或泄漏响应体、不添加凭据、不自动重试', async ({ run, method, path }) => {
    const response = unauthorized();
    const json = vi.spyOn(response, 'json');
    const text = vi.spyOn(response, 'text');
    const store = vi.spyOn(Storage.prototype, 'setItem');
    const cookie = vi.spyOn(document, 'cookie', 'set');
    const fetch = vi.fn<ManagementTransport>().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const result = await run(createManagementApi(), signal);
    expect(result).toEqual(authError);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_PROXY_DETAIL|<html>|Unauthorized/);
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(path, expect.objectContaining({ method, signal }));
    const init = fetch.mock.calls[0]![1];
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(init.credentials).toBeUndefined();
    expect(init).not.toHaveProperty('redirect');
    expect(store).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
  });

  it.each(operations)('$name 已取消时不发送请求', async ({ run }) => {
    const fetch = vi.fn<ManagementTransport>().mockResolvedValue(unauthorized());
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    expect(await run(createManagementApi(), controller.signal)).toEqual({ status: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(operations)('$name 传输忽略取消并返回 401 时，取消仍优先', async ({ run }) => {
    const controller = new AbortController();
    const response = unauthorized();
    const json = vi.spyOn(response, 'json');
    const fetch = vi.fn<ManagementTransport>().mockImplementation(async () => {
      controller.abort();
      return response;
    });
    vi.stubGlobal('fetch', fetch);
    expect(await run(createManagementApi(), controller.signal)).toEqual({ status: 'cancelled' });
    expect(json).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });

  it.each(operations)('$name 传输取消并抛错时不报告认证错误', async ({ run }) => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn<ManagementTransport>().mockImplementation(async () => {
      controller.abort();
      throw new Error('PRIVATE_PROXY_DETAIL');
    }));
    expect(await run(createManagementApi(), controller.signal)).toEqual({ status: 'cancelled' });
  });

  it.each(operations.filter(operation => operation.method === 'DELETE'))('$name 正常 204 不解析 JSON', async ({ run }) => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, 'json');
    vi.stubGlobal('fetch', vi.fn<ManagementTransport>().mockResolvedValue(response));
    expect(await run(createManagementApi(), new AbortController().signal)).toEqual({ status: 'success', data: undefined });
    expect(json).not.toHaveBeenCalled();
  });

  it.each(['getUp', 'addUp', 'updateMonitor'] as const)('%s 保留正常 DTO 的字段映射', async name => {
    const response = Response.json({ uid, name: '测试 UP', avatar_url: null,
      monitor: { mode: 'recent', recent_n: 10, enabled: true, last_checked_at: null, last_succeeded_at: null },
    }, { status: name === 'addUp' ? 201 : 200 });
    vi.stubGlobal('fetch', vi.fn<ManagementTransport>().mockResolvedValue(response));
    const operation = operations.find(operation => operation.name === name)!;
    expect(await operation.run(createManagementApi(), new AbortController().signal)).toEqual({ status: 'success', data: {
      uid, name: '测试 UP', avatarUrl: null,
      monitor: { ...monitor, lastCheckedAt: null, lastSucceededAt: null },
    } });
  });
});

function show(api: ManagementApi) {
  return render(<MemoryRouter initialEntries={['/manage']}><SessionProvider>
    <ManagePage api={api} />
  </SessionProvider></MemoryRouter>);
}
function unusedApi() {
  return createManagementApi(vi.fn<ManagementTransport>().mockRejectedValue(new Error('Unexpected transport')));
}

describe('管理页的认证失败提示', () => {
  it('读取认证失败仅显示安全提示，不自动重试', async () => {
    const listUps = vi.fn<ManagementApi['listUps']>().mockResolvedValue({ status: 'error', message: authenticationRequiredMessage });
    show({ ...unusedApi(), listUps });
    expect(await screen.findByRole('alert')).toHaveTextContent(authenticationRequiredMessage);
    // 401 映射只是防御性提示，不代表仓库内已有认证网关。
    expect(screen.getByRole('link', { name: '返回阅读' })).toHaveAttribute('href', '/');
    expect(listUps).toHaveBeenCalledTimes(1);
  });

  it('操作认证失败不回显响应体、不自动重试操作', async () => {
    const user = userEvent.setup();
    const listUps = vi.fn<ManagementApi['listUps']>().mockResolvedValue({ status: 'success', data: [] });
    const addUp = vi.fn<ManagementApi['addUp']>().mockResolvedValue({ status: 'error', message: authenticationRequiredMessage });
    show({ ...unusedApi(), listUps, addUp });
    const input = await screen.findByRole('textbox', { name: 'UP UID' });
    const reads = listUps.mock.calls.length;
    await user.type(input, uid);
    await user.click(screen.getByRole('button', { name: '添加监控' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(authenticationRequiredMessage);
    expect(input).toHaveValue(uid);
    expect(addUp).toHaveBeenCalledTimes(1);
    expect(listUps).toHaveBeenCalledTimes(reads);
  });
});
