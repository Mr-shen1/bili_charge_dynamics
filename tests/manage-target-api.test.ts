import { describe, expect, it } from 'vitest';
import { createManagementApi } from '../src/manage/managementApi';
const signal = new AbortController().signal;
const uid = '123';
const id = '900719925474099312345';
describe('指定目标管理 HTTP 映射', () => {
  it('输入与响应严格校验，失败和取消不伪装成功或泄漏秘密', async () => {
    let calls = 0;
    const api = createManagementApi(async () => { calls++; return Response.json({ id }, { status: 201 }); });
    for (const badId of ['0', '01', '1e3', '', '123 ', '../123', '1'.repeat(129)]) {
      expect(await api.addTarget({ uid, id: badId, signal })).toMatchObject({ status: 'error' });
      expect(await api.deleteTarget({ uid, id: badId, signal })).toMatchObject({ status: 'error' });
    }
    expect(calls).toBe(0);
    for (const body of [null, { targets: [{ id: 123 }] }, { targets: [{ id }, { id }] }, { targets: 'SECRET_TOKEN' }]) {
      expect(await createManagementApi(async () => Response.json(body)).listTargets({ uid, signal })).toMatchObject({ status: 'error' });
    }
    expect(await createManagementApi(async () => Response.json({ id: '999' }, { status: 201 })).addTarget({ uid, id, signal })).toMatchObject({ status: 'error' });
    expect(await createManagementApi(async () => Response.json({ id })).deleteTarget({ uid, id, signal })).toMatchObject({ status: 'error' });
    for (const transport of [async () => new Response('SECRET_TOKEN'), async () => { throw new Error('SECRET_TOKEN'); },
      async () => Response.json({ error: { code: 'TARGET_AUTHOR_MISMATCH', message: 'SECRET_TOKEN' } }, { status: 502 })]) {
      const result = await createManagementApi(transport).addTarget({ uid, id, signal });
      expect(result).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
    }
    const controller = new AbortController();
    const cancelled = createManagementApi(async () => { controller.abort(); return Response.json({ id }, { status: 201 }); });
    expect(await cancelled.addTarget({ uid, id, signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(await api.deleteTarget({ uid, id, signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(calls).toBe(0);
  });
  it.each([[409, 'TARGET_AUTHOR_MISMATCH', '动态作者与所选 UP 不符。'], [502, 'TARGET_UNVERIFIED', '无法确认动态归属。']] as const)(
    '归属错误 %s/%s 使用固定安全中文，响应秘密不泄漏', async (status, code, message) => {
      const api = createManagementApi(async () => Response.json({ error: { code, message: 'SECRET_TOKEN' } }, { status }));
      expect(await api.addTarget({ uid, id, signal })).toEqual({ status: 'error', message });
    });
  it('字符串 ID 添加校验成功、读取与删除；只发送管理请求，不调用初始化', async () => {
    let targets: { id: string }[] = [];
    const api = createManagementApi(async (url, init) => {
      expect(url).toBe(`/api/manage/ups/123/targets${init.method === 'DELETE' ? `/${id}` : ''}`);
      expect(init.signal).toBe(signal);
      if (init.method === 'POST') {
        expect(init.body).toBe('{"id":"900719925474099312345"}');
        targets = [{ id }]; return Response.json({ id }, { status: 201 });
      }
      if (init.method === 'DELETE') { targets = []; return new Response(null, { status: 204 }); }
      return Response.json({ targets });
    });
    expect(await api.addTarget({ uid, id, signal })).toEqual({ status: 'success', data: { id } });
    expect(await api.listTargets({ uid, signal })).toEqual({ status: 'success', data: [{ id }] });
    expect(await api.deleteTarget({ uid, id, signal })).toEqual({ status: 'success', data: undefined });
    expect(await api.listTargets({ uid, signal })).toEqual({ status: 'success', data: [] });
  });
});
