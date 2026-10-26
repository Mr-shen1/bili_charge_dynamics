import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// 10：三个真实进程（API＋独立采集＋独立通知）共享临时 SQLite，通知进程把消息发到
// 本机受控 HTTP 接收端；这里取消息里的**实际链接**，在生产前端装配里打开、刷新、返回，
// 宽窄屏各走一遍，并验证代理语义与只读读取不触发采集。
// 只替换外部来源/媒体/上传与飞书 HTTP；身份、动态、评论与凭据全部虚构。

const apiPort = Number(process.env.DELIVERY_E2E_API_PORT ?? 4181);
const webPort = Number(process.env.DELIVERY_E2E_WEB_PORT ?? 4328);
const repo = resolve(process.cwd(), '..');
const baseURL = `http://127.0.0.1:${webPort}`;
const apiURL = `http://127.0.0.1:${apiPort}`;
const python = resolve(repo, '.venv/bin/python');
const uid = '202';
const otherUid = '707';
const dynamicId = '123';
const otherDynamic = '124';
const title = '虚构三进程标题';
// 45 条根评论按热度递减：第 30 条在第二批；第 1 条带 25 条回复，目标回复在第 3 页。
const rootTarget = '860030';
const replyRoot = '860001';
const replyTarget = '960022';

const directory = mkdtempSync(join(tmpdir(), 'bili-delivery-e2e-'));
const database = join(directory, 'delivery.sqlite');
const statePath = join(directory, 'state.json');
// 只统计 API 进程的上游请求：采集进程按固定节拍持续采样，不能混进“读取不触发采集”的断言。
const requestsLog = join(directory, 'api-source-requests.log');
const collectorRequestsLog = join(directory, 'collector-source-requests.log');
const configPath = join(directory, 'notifications.json');
const children = new Map<string, ChildProcess>();
const logs = new Map<string, string>();
let receiver: Server | undefined;
const received: Array<{ path: string; payload: Record<string, unknown> }> = [];

type Links = {
  dynamic: string;
  otherDynamic: string;
  rootTarget: string;
  replyTarget: string;
  upTokens: string[];
  allTokens: string[];
};

const collected: { links?: Links; failure?: string } = {};

function state(version: 'v1' | 'v2') {
  return {
    dynamics: {
      [dynamicId]: {
        uid, name: '虚构晨光', title, version,
        text: version === 'v1' ? '第一版正文' : '第二版正文',
        comments: version === 'v1' ? {} : {
          size: 45, fresh: [1, 2, 3], fresh_other: [30], pure_image: 2, long: 3,
          reply_root: replyRoot, reply_size: 25, fresh_replies: [22],
        },
      },
      [otherDynamic]: {
        uid: otherUid, name: '虚构晚风', title: null, version,
        text: version === 'v1' ? '另一条第一版正文' : '另一条第二版正文',
        comments: version === 'v1' ? {} : { size: 1, fresh: [1] },
      },
    },
  };
}

function environment(extra: Record<string, string>) {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(BILI_|DELIVERY_|UVICORN_)/.test(name) || name === 'WEB_CONCURRENCY') continue;
    values[name] = value;
  }
  return { ...values, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...extra };
}

function start(name: string, args: string[], extra: Record<string, string>) {
  const log = join(directory, `${name}.log`);
  logs.set(name, log);
  const child = spawn(python, args, {
    cwd: repo, env: environment(extra), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk: Buffer) => writeFileSync(log, chunk, { flag: 'a' });
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  children.set(name, child);
  return child;
}

function logText() {
  return [...logs.entries()].map(([name, path]) => {
    try {
      return `--- ${name} ---\n${readFileSync(path, 'utf8')}`;
    } catch {
      return `--- ${name} --- (no log)`;
    }
  }).join('\n');
}

function stop(name: string) {
  const child = children.get(name);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    // 同步等待在测试钩子里可接受：进程在 TERM 后清理在途工作并退出。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function waitFor<T>(description: string, probe: () => Promise<T | false | undefined>, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise(accept => setTimeout(accept, 100));
  }
  throw new Error(`等待超时：${description}${last ? `（最近错误：${String(last)}）` : ''}\n${logText()}`);
}

async function get(path: string) {
  const response = await fetch(`${apiURL}${path}`);
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${apiURL}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function patch(path: string, body: unknown) {
  const response = await fetch(`${apiURL}${path}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function payloadText(payload: Record<string, unknown>): string {
  const content = (payload as {
    content: { post: { zh_cn: { content: Array<Array<{ text?: string }>> } } };
  }).content.post.zh_cn.content;
  return content.map(paragraph => paragraph.map(node => node.text ?? '').join('')).join('\n');
}

function payloadLink(payload: Record<string, unknown>): string {
  const content = (payload as {
    content: { post: { zh_cn: { content: Array<Array<{ tag?: string; href?: string }>> } } };
  }).content.post.zh_cn.content;
  return content.flat().find(node => node.tag === 'a')?.href ?? '';
}

function linkFor(token: string, fragment: string) {
  return received
    .filter(item => item.path.endsWith(`/hook/${token}`))
    .map(item => payloadLink(item.payload))
    .find(link => link.includes(fragment));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  writeFileSync(statePath, JSON.stringify(state('v1'), null, 0));
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      try {
        received.push({ path: request.url ?? '', payload: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
      } catch {
        received.push({ path: request.url ?? '', payload: {} });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, msg: 'success' }));
    });
  });
  await new Promise<void>(accept => receiver!.listen(0, '127.0.0.1', () => accept()));
  const hook = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/open-apis/bot/v2/hook`;

  start('api', ['-m', 'uvicorn', 'backend.tests.delivery_fixture:create_app', '--factory',
    '--host', '127.0.0.1', '--port', String(apiPort)], {
    BILI_DATABASE_PATH: database, DELIVERY_FIXTURE_STATE: statePath,
    DELIVERY_FIXTURE_REQUESTS: requestsLog, PYTHONUNBUFFERED: '1',
  });
  await waitFor('API 就绪', async () => (await get('/api/manage/ups')).status === 200);

  for (const [targetUid, targetDynamic] of [[uid, dynamicId], [otherUid, otherDynamic]] as const) {
    expect((await post('/api/manage/ups', { uid: targetUid })).status).toBe(201);
    expect((await patch(`/api/manage/ups/${targetUid}/monitor`,
      { mode: 'specified', recent_n: 10, enabled: true })).status).toBe(200);
    expect((await post(`/api/manage/ups/${targetUid}/targets`, { id: targetDynamic })).status).toBe(201);
  }

  start('collector', ['-m', 'backend.tests.delivery_fixture', '--database', database], {
    BILI_DATABASE_PATH: database, DELIVERY_FIXTURE_STATE: statePath,
    DELIVERY_FIXTURE_REQUESTS: collectorRequestsLog, BILI_COLLECTOR_CADENCE_SECONDS: '1',
    BILI_COLLECTOR_PAGE_CHECK_SECONDS: '0', PYTHONUNBUFFERED: '1',
  });
  await waitFor('第一版正文归档', async () => (await get(`/api/archive/dynamics/${dynamicId}`)).text.includes('第一版正文'));
  await waitFor('另一条第一版正文归档',
    async () => (await get(`/api/archive/dynamics/${otherDynamic}`)).text.includes('另一条第一版正文'));

  writeFileSync(configPath, JSON.stringify({
    base_url: baseURL,
    ups: { [uid]: { up: 'up-202', all: 'all-202' }, [otherUid]: { up: 'up-707', all: 'all-707' } },
    system: 'system-10',
    destinations: {
      'up-202': { webhook: `${hook}/up-202` }, 'all-202': { webhook: `${hook}/all-202` },
      'up-707': { webhook: `${hook}/up-707` }, 'all-707': { webhook: `${hook}/all-707` },
      'system-10': { webhook: `${hook}/system-10` },
    },
  }));
  start('notifier', ['-m', 'backend.bili_monitor.notifier'], {
    BILI_DATABASE_PATH: database, BILI_NOTIFICATION_CONFIG: configPath, PYTHONUNBUFFERED: '1',
  });

  writeFileSync(statePath, JSON.stringify(state('v2'), null, 0));
  await waitFor('第二版正文归档', async () => (await get(`/api/archive/dynamics/${dynamicId}`)).text.includes('第二版正文'));
  const links = await waitFor('三链实际投递消息', async () => {
    const dynamicLink = linkFor('up-202', `/dynamics/${dynamicId}`);
    const rootLink = linkFor('all-202', `/comments/${rootTarget}/locate`);
    const replyLink = linkFor('all-202', `/replies/${replyTarget}/locate`);
    const otherCommentLink = linkFor('all-707', `/dynamics/${otherDynamic}/comments/`);
    if (!dynamicLink || !rootLink || !replyLink || !otherCommentLink) return false;
    const upTokens = received.filter(item => item.path.endsWith('/up-202')).map(item => payloadLink(item.payload));
    const allTokens = received.filter(item => item.path.endsWith('/all-202')).map(item => payloadLink(item.payload));
    return {
      dynamic: dynamicLink, otherDynamic: linkFor('up-707', `/dynamics/${otherDynamic}`) ?? '',
      rootTarget: rootLink, replyTarget: replyLink,
      upTokens, allTokens,
    } satisfies Links;
  });
  collected.links = links;
});

test.afterAll(async () => {
  for (const name of [...children.keys()].reverse()) stop(name);
  await new Promise<void>(accept => receiver?.close(() => accept()) ?? accept());
});

async function sourceRequests(): Promise<number> {
  try {
    return readFileSync(requestsLog, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function located(page: Page) {
  return page.locator('[data-located="true"]');
}

function links(): Links {
  if (!collected.links) throw new Error('三进程链路未建立');
  return collected.links;
}

test('实际投递的动态链接打开生产前端后可见归档正文，刷新与返回仍可用', async ({ page }) => {
  const link = links().dynamic;
  expect(link).toBe(`${baseURL}/dynamics/${dynamicId}`);
  await page.goto(link);
  await expect(page.getByText('第二版正文', { exact: false }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('第二版正文', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('article')).toHaveCount(2);
});

test('一级评论后续批链接直开、刷新与窄屏都能定位到目标本身', async ({ page }) => {
  const link = links().rootTarget;
  expect(link).toBe(`${baseURL}/dynamics/${dynamicId}/comments/${rootTarget}/locate`);
  // 目标确实不在首批：最热首批 20 条里没有它。
  const first = await (await page.request.get(`/api/archive/dynamics/${dynamicId}/comments?sort=hot&limit=20`)).json();
  expect(first.items).toHaveLength(20);
  expect(first.items.some((item: { id: string }) => item.id === rootTarget)).toBe(false);

  await page.goto(link);
  await expect(page.locator(`[data-reading-id="comment:${rootTarget}"]`)).toHaveAttribute('data-located', 'true');
  await expect(located(page)).toHaveCount(1);
  await expect.poll(() => page.locator(`[data-reading-id="comment:${rootTarget}"]`)
    .evaluate(element => Math.round(element.getBoundingClientRect().top))).toBeLessThan(24);
  await page.reload();
  await expect(page.locator(`[data-reading-id="comment:${rootTarget}"]`)).toHaveAttribute('data-located', 'true');

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(link);
  await expect(page.locator(`[data-reading-id="comment:${rootTarget}"]`)).toHaveAttribute('data-located', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
});

test('楼中楼后续页回复链接在宽屏内联与窄屏独立页都定位到目标回复', async ({ page }) => {
  const link = links().replyTarget;
  expect(link).toBe(`${baseURL}/dynamics/${dynamicId}/comments/${replyRoot}/replies/${replyTarget}/locate`);
  const location = await (await page.request.get(
    `/api/archive/dynamics/${dynamicId}/comments/${replyRoot}/replies/${replyTarget}/location`)).json();
  expect(location.page).toBe(3);
  expect(location.items.at(-1).id).toBe(replyTarget);

  await page.goto(link);
  const wideTarget = page.locator(`[data-reading-id="reply:${replyRoot}:${replyTarget}"]`);
  await expect(wideTarget).toHaveAttribute('data-located', 'true');
  await expect(located(page)).toHaveCount(1);
  await page.reload();
  await expect(wideTarget).toHaveAttribute('data-located', 'true');

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(link);
  // 窄屏走独立楼中楼页，目标仍在第 3 页并高亮。
  await expect(page.getByRole('button', { name: '返回评论' })).toBeVisible();
  await expect(page.locator(`[data-reading-id="reply:${replyRoot}:${replyTarget}"]`))
    .toHaveAttribute('data-located', 'true');
  await expect(located(page)).toHaveCount(1);
  await page.reload();
  await expect(page.locator(`[data-reading-id="reply:${replyRoot}:${replyTarget}"]`))
    .toHaveAttribute('data-located', 'true');
});

test('不存在的目标给出明确提示并保留返回入口，API 错误不冒充页面成功', async ({ page }) => {
  await page.goto(`${baseURL}/dynamics/${dynamicId}/comments/999999/locate`);
  await expect(page.getByRole('status').filter({ hasText: '目标评论不存在或未归档' })).toBeVisible();
  await page.getByRole('button', { name: '返回动态' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));

  await page.goto(`${baseURL}/dynamics/${dynamicId}/comments/${replyRoot}/replies/999999/locate`);
  await expect(page.getByRole('status').filter({ hasText: '目标回复不存在或未归档' })).toBeVisible();

  // 代理语义：API 的 404/422 保持 JSON 且不回退到应用入口（不把错误伪装成成功页面）。
  for (const path of [`/api/archive/dynamics/${dynamicId}/comments/999999/location`,
    `/api/archive/dynamics/${dynamicId}/comments?limit=0`, '/api/no-such-route']) {
    const response = await page.request.get(path);
    expect([404, 422]).toContain(response.status());
    expect(response.headers()['content-type']).toContain('application/json');
    expect((await response.text()).includes('<div id="app">')).toBe(false);
  }
});

test('实际投递按路由矩阵分群，读取消息链接不触发来源采集', async ({ page }) => {
  const current = links();
  expect(current.upTokens).toContain(`${baseURL}/dynamics/${dynamicId}`);
  expect(current.allTokens).not.toContain(`${baseURL}/dynamics/${dynamicId}`);
  expect(current.upTokens).toContain(`${baseURL}/dynamics/${dynamicId}/comments/860001/locate`);
  expect(current.allTokens).toContain(`${baseURL}/dynamics/${dynamicId}/comments/${rootTarget}/locate`);
  expect(current.allTokens).toContain(`${baseURL}/dynamics/${dynamicId}/comments/${rootTarget}/locate`);
  expect(current.upTokens).not.toContain(`${baseURL}/dynamics/${dynamicId}/comments/${rootTarget}/locate`);
  expect(current.otherDynamic).toBe(`${baseURL}/dynamics/${otherDynamic}`);
  // 消息快照来自实际归档：标题缺失的 124 回退动态 ID，纯图与超长提示按模板出现。
  const texts = received.map(item => payloadText(item.payload));
  expect(texts.some(text => text.includes(`动态【${otherDynamic}】发生变化`))).toBe(true);
  expect(texts.some(text => text.includes('内容：【图片评论，点击链接查看】'))).toBe(true);
  expect(texts.some(text => text.includes('……内容过长，点击链接查看全文'))).toBe(true);

  const before = await sourceRequests();
  await page.goto(current.dynamic);
  await page.goto(current.rootTarget);
  await page.goto(current.replyTarget);
  await page.request.get(`/api/archive/dynamics/${dynamicId}/comments`);
  expect(await sourceRequests()).toBe(before);
  // 归档仍可读，页面没有篡改归档内容。
  const archive = await (await page.request.get(`/api/archive/dynamics/${dynamicId}`)).json();
  expect(archive.text).toContain('第二版正文');
  expect(statSync(database).size).toBeGreaterThan(0);
});
