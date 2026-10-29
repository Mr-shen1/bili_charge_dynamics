import { expect, it } from 'vitest';
import { createArchiveReader } from '../../src/data/archiveReader';
import { archiveReply, archiveRoot } from '../fixtures/replies';

function signature(url: string): string {
  const parsed = new URL(url, 'http://local');
  return parsed.pathname + parsed.search;
}

const signal = () => new AbortController().signal;

it('预览用 cursor 模式只带 limit=3，不请求页码也不加缓存参数', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const reader = createArchiveReader(async (url, init) => {
    requests.push({ url, init });
    return Response.json({ items: [archiveReply(1)], next_cursor: 'preview-cursor' });
  });

  const result = await reader.readReplies({ dynamicId: '1001', rootId: '5001', limit: 3, signal: signal() });
  if (result.status !== 'success') throw new Error('预览应成功');
  expect(result.data.nextCursor).toBe('preview-cursor');
  expect(requests.map(request => signature(request.url))).toEqual([
    '/api/archive/dynamics/1001/comments/5001/replies?limit=3',
  ]);
  expect(requests[0]!.init.method).toBe('GET');
  expect(requests[0]!.init.cache).toBeUndefined();
});

it('展开走页码模式：固定 limit=10、请求 no-store，每页都带 count 与根评论', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const reader = createArchiveReader(async (url, init) => {
    requests.push({ url, init });
    return Response.json({
      items: [archiveReply(11), archiveReply(12)],
      next_cursor: null,
      count: 25,
      root: archiveRoot(),
      source_reply_count: 27,
      local_reply_count: 25,
      replies_last_attempt: 'success',
      synced_source_reply_count: 25,
    });
  });

  const result = await reader.readReplies({
    dynamicId: '1001', rootId: '5001', page: 2, limit: 10, signal: signal(),
  });
  if (result.status !== 'success') throw new Error('页码读取应成功');
  expect(result.data).toMatchObject({
    count: 25, sourceReplyCount: 27, localReplyCount: 25, repliesLastAttempt: 'success',
    syncedSourceReplyCount: 25, nextCursor: null,
  });
  expect(result.data.root?.id).toBe('5001');
  expect(requests.map(request => signature(request.url))).toEqual([
    '/api/archive/dynamics/1001/comments/5001/replies?page=2&limit=10',
  ]);
  expect(requests[0]!.init.cache).toBe('no-store');
});

it('页码模式可显式下发 sort=hot：仍是同一条 no-store 实时请求', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const reader = createArchiveReader(async (url, init) => {
    requests.push({ url, init });
    return Response.json({
      items: [archiveReply(22)], next_cursor: null, count: 25, root: archiveRoot(),
    });
  });

  const result = await reader.readReplies({
    dynamicId: '1001', rootId: '5001', page: 1, limit: 10, sort: 'hot', signal: signal(),
  });
  expect(result.status).toBe('success');
  expect(requests.map(request => signature(request.url))).toEqual([
    '/api/archive/dynamics/1001/comments/5001/replies?page=1&limit=10&sort=hot',
  ]);
  expect(requests[0]!.init.cache).toBe('no-store');
});

it('省略排序的页码读取不发 sort 参数，既有调用方不受新契约影响', async () => {
  const requests: string[] = [];
  const reader = createArchiveReader(async url => {
    requests.push(signature(url));
    return Response.json({ items: [], next_cursor: null, count: 25, root: archiveRoot() });
  });
  await reader.readReplies({ dynamicId: '1001', rootId: '5001', page: 3, limit: 10, signal: signal() });
  expect(requests).toEqual(['/api/archive/dynamics/1001/comments/5001/replies?page=3&limit=10']);
});

it('排序只属于页码模式：cursor 预览带 sort 或非法排序值直接按契约错误，不发请求', async () => {
  const requests: string[] = [];
  const reader = createArchiveReader(async url => {
    requests.push(signature(url));
    return Response.json({ items: [], next_cursor: null });
  });
  const misuses = [
    { dynamicId: '1001', rootId: '5001', limit: 3, sort: 'time' as const, signal: signal() },
    { dynamicId: '1001', rootId: '5001', limit: 10, cursor: 'next', sort: 'hot' as const, signal: signal() },
    // 运行时防护：外部调用方传入未声明的排序值不能变成服务端的 422。
    { dynamicId: '1001', rootId: '5001', page: 1, limit: 10, sort: 'latest' as never, signal: signal() },
  ];
  for (const input of misuses) {
    expect(await reader.readReplies(input)).toEqual({ status: 'error' });
  }
  expect(requests).toEqual([]);
});

it('页码越过末页是成功空页并带实际本地总数，不当作不存在', async () => {
  const reader = createArchiveReader(async () => Response.json({
    items: [], next_cursor: null, count: 25, root: archiveRoot(),
  }));

  const result = await reader.readReplies({
    dynamicId: '1001', rootId: '5001', page: 9, limit: 10, signal: signal(),
  });
  if (result.status !== 'success') throw new Error('越界页应返回成功空页');
  expect(result.data).toMatchObject({ items: [], count: 25 });
});

it('只把 422 CURSOR_INVALID 映射为 invalid-cursor，404 与 422 INVALID_INPUT 是普通错误', async () => {
  const cases: { status: number; body: unknown; expected: string | undefined }[] = [
    { status: 422, body: { error: { code: 'CURSOR_INVALID' } }, expected: 'invalid-cursor' },
    { status: 404, body: { error: { code: 'NOT_FOUND' } }, expected: undefined },
    { status: 422, body: { error: { code: 'INVALID_INPUT' } }, expected: undefined },
    { status: 503, body: { error: { code: 'STORAGE_UNAVAILABLE' } }, expected: undefined },
  ];
  for (const item of cases) {
    const reader = createArchiveReader(async () => Response.json(item.body, { status: item.status }));
    const result = await reader.readReplies({ dynamicId: '1001', rootId: '5001', limit: 3, signal: signal() });
    expect(result, `${item.status}`).toEqual({ status: 'error', reason: item.expected });
  }
});

it('页码响应缺根评论、根评论不符或 next_cursor 非空都按安全错误处理', async () => {
  const bodies = [
    { items: [archiveReply(1)], next_cursor: null, count: 25 },
    { items: [archiveReply(1)], next_cursor: null, count: 25, root: archiveRoot({ id: '5002' }) },
    { items: [archiveReply(1)], next_cursor: 'next', count: 25, root: archiveRoot() },
    { items: [archiveReply(1)], next_cursor: null, root: archiveRoot() },
    { items: [archiveReply(1, { root_id: '5002' })], next_cursor: null, count: 25, root: archiveRoot() },
  ];
  for (const body of bodies) {
    const reader = createArchiveReader(async () => Response.json(body));
    const result = await reader.readReplies({
      dynamicId: '1001', rootId: '5001', page: 1, limit: 10, signal: signal(),
    });
    expect(result).toEqual({ status: 'error' });
  }
});

it('非法页码、混用 cursor 与错误批量在传输前就被拒绝', async () => {
  let requests = 0;
  const reader = createArchiveReader(async () => {
    requests += 1;
    return Response.json({ items: [], next_cursor: null });
  });
  const cases = [
    { page: 0, limit: 10 },
    { page: -1, limit: 10 },
    { page: 1.5, limit: 10 },
    { page: Number.MAX_SAFE_INTEGER + 1, limit: 10 },
    { page: 1, limit: 9 },
    { page: 1, limit: 10, cursor: 'c' },
  ];
  for (const item of cases) {
    const result = await reader.readReplies({
      dynamicId: '1001', rootId: '5001', signal: signal(), ...item,
    });
    expect(result, JSON.stringify(item)).toEqual({ status: 'error' });
  }
  // 续批 cursor 只允许 10 条批量。
  expect(await reader.readReplies({ dynamicId: '1001', rootId: '5001', cursor: 'c', limit: 3, signal: signal() }))
    .toEqual({ status: 'error' });
  expect(requests).toBe(0);
});

it('回复 DTO 映射保留嵌套目标、正文与身份，取消优先于成功', async () => {
  const reader = createArchiveReader(async () => Response.json({
    items: [
      archiveReply(1, {
        // 父评论不是根评论也不是自己：界面据此显示“回复 X:”。
        parent_id: '9005',
        reply_to: { id: '7002', nickname: '被回复的人', avatar_url: null },
        text: '回复 @被回复的人: 嵌套内容',
      }),
      archiveReply(2, { author: { id: null, nickname: null, avatar_url: 'javascript:alert(1)' }, published_at: null }),
    ],
    next_cursor: null,
  }));

  const result = await reader.readReplies({ dynamicId: '1001', rootId: '5001', limit: 3, signal: signal() });
  if (result.status !== 'success') throw new Error('读取应成功');
  expect(result.data.items[0]).toMatchObject({
    id: '9001', parentId: '9005', text: '回复 @被回复的人: 嵌套内容',
    replyTo: { id: '7002', nickname: '被回复的人', avatarUrl: null },
  });
  expect(result.data.items[1]).toMatchObject({
    author: { id: '', nickname: null, avatarUrl: null }, publishedAt: null, replyTo: null, parentId: null,
  });

  const controller = new AbortController();
  controller.abort();
  const cancelled = createArchiveReader(async () => Response.json({ items: [], next_cursor: null }));
  expect(await cancelled.readReplies({ dynamicId: '1001', rootId: '5001', limit: 3, signal: controller.signal }))
    .toEqual({ status: 'cancelled' });
});

it('定位读取走 location 端点：保留目标所在页码、根评论与逐根状态，请求 no-store', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const reader = createArchiveReader(async (url, init) => {
    requests.push({ url, init });
    return Response.json({
      items: [archiveReply(11), archiveReply(12)],
      next_cursor: null,
      page: 2,
      count: 25,
      root: archiveRoot(),
      source_reply_count: 27,
      local_reply_count: 25,
      replies_last_attempt: 'success',
      synced_source_reply_count: 25,
    });
  });

  const result = await reader.locateReply({
    dynamicId: '1001', rootId: '5001', replyId: '9012', signal: signal(),
  });
  if (result.status !== 'success') throw new Error('定位读取应成功');
  expect(result.data).toMatchObject({
    page: 2, count: 25, sourceReplyCount: 27, localReplyCount: 25,
    repliesLastAttempt: 'success', nextCursor: null,
  });
  expect(result.data.root?.id).toBe('5001');
  expect(result.data.items.map(item => item.id)).toEqual(['9011', '9012']);
  expect(requests.map(request => signature(request.url))).toEqual([
    '/api/archive/dynamics/1001/comments/5001/replies/9012/location',
  ]);
  expect(requests[0]!.init.method).toBe('GET');
  expect(requests[0]!.init.cache).toBe('no-store');
});

it('定位读取：404 与非法身份是 not-found，其他失败可重试，页内没有目标不算定位成功', async () => {
  let requests = 0;
  const notFound = createArchiveReader(async () => {
    requests += 1;
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  });
  expect(await notFound.locateReply({ dynamicId: '1001', rootId: '5001', replyId: '9001', signal: signal() }))
    .toEqual({ status: 'not-found' });
  // 非法身份不发请求：等同于这个位置没有可读回复。
  for (const item of [
    { dynamicId: 'x', rootId: '5001', replyId: '9001' },
    { dynamicId: '1001', rootId: '', replyId: '9001' },
    { dynamicId: '1001', rootId: '5001', replyId: '0x1' },
  ]) {
    expect(await notFound.locateReply({ ...item, signal: signal() })).toEqual({ status: 'not-found' });
  }
  expect(requests).toBe(1);

  // 临时失败与不存在分开：非 200、DTO 不合法、页码缺失或目标不在页内都是可重试错误。
  const bodies: { status: number; body: unknown }[] = [
    { status: 503, body: { error: { code: 'STORAGE_UNAVAILABLE' } } },
    { status: 200, body: { items: [archiveReply(11)], next_cursor: null, count: 25, root: archiveRoot() } },
    {
      status: 200,
      body: { items: [archiveReply(11)], next_cursor: null, page: 2, count: 25,
        root: archiveRoot({ id: '5002' }) },
    },
    {
      status: 200,
      body: { items: [], next_cursor: null, page: 2, count: 25, root: archiveRoot() },
    },
    {
      status: 200,
      body: { items: [archiveReply(11), archiveReply(12)], next_cursor: null, page: 2, count: 25,
        root: archiveRoot() },
    },
  ];
  for (const item of bodies) {
    const reader = createArchiveReader(async () => Response.json(item.body, { status: item.status }));
    expect(await reader.locateReply({ dynamicId: '1001', rootId: '5001', replyId: '9001', signal: signal() }),
      JSON.stringify(item.body)).toEqual({ status: 'error' });
  }

  const controller = new AbortController();
  controller.abort();
  const cancelled = createArchiveReader(async () => Response.json({ items: [], next_cursor: null }));
  expect(await cancelled.locateReply({ dynamicId: '1001', rootId: '5001', replyId: '9001', signal: controller.signal }))
    .toEqual({ status: 'cancelled' });
});

it('页码与定位条目映射可空对话投影：缺少字段不推断，形状非法整页拒绝', async () => {
  const projected = {
    start_id: '9001', count: 14, incomplete: false,
  };
  const reader = createArchiveReader(async () => Response.json({
    items: [
      archiveReply(1, { conversation: projected }),
      archiveReply(2, { conversation: { start_id: '9001', count: 2, incomplete: true } }),
      archiveReply(3, { conversation: null }),
    ],
    next_cursor: null, count: 25, root: archiveRoot(),
  }));
  const page = await reader.readReplies({ dynamicId: '1001', rootId: '5001', page: 1, limit: 10, signal: signal() });
  if (page.status !== 'success') throw new Error('页码读取应成功');
  expect(page.data.items.map(item => item.conversation)).toEqual([
    { startId: '9001', count: 14, incomplete: false },
    { startId: '9001', count: 2, incomplete: true },
    null,
  ]);

  // cursor 预览的冻结响应不带该字段：不补造 false/null，也不触发首页投影。
  const preview = createArchiveReader(async () => Response.json({ items: [archiveReply(1)], next_cursor: null }));
  const cursor = await preview.readReplies({ dynamicId: '1001', rootId: '5001', limit: 3, signal: signal() });
  if (cursor.status !== 'success') throw new Error('预览应成功');
  expect(cursor.data.items[0]!.conversation).toBeNull();

  for (const conversation of [
    { start_id: '9001', count: -1, incomplete: false },
    { start_id: '', count: 2, incomplete: false },
    { start_id: '9001', count: 2, incomplete: 'no' },
    { start_id: '9001', incomplete: false },
    'projected',
  ]) {
    const broken = createArchiveReader(async () => Response.json({
      items: [archiveReply(1, { conversation })], next_cursor: null, count: 25, root: archiveRoot(),
    }));
    expect(await broken.readReplies({ dynamicId: '1001', rootId: '5001', page: 1, limit: 10, signal: signal() }),
      JSON.stringify(conversation)).toEqual({ status: 'error' });
  }
});

/** 整段会话夹具：`count` 与条目数一致，整段响应里没有 `page` 键。 */
function conversationBody(overrides: Record<string, unknown> = {}) {
  return {
    dynamic_id: '1001', root_id: '5001', reply_id: '9004', start_id: '9001',
    incomplete: false, count: 14, next_cursor: null,
    items: Array.from({ length: 14 }, (_value, index) => archiveReply(index + 1)),
    ...overrides,
  };
}

it('会话读取只发一条 no-store 整段请求，返回所属身份、起点与全部条目', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const reader = createArchiveReader(async (url, init) => {
    requests.push({ url, init });
    return Response.json(conversationBody());
  });

  const result = await reader.readConversation({
    dynamicId: '1001', rootId: '5001', replyId: '9004', signal: signal(),
  });
  if (result.status !== 'success') throw new Error('会话读取应成功');
  expect(result.data).toMatchObject({
    dynamicId: '1001', rootId: '5001', replyId: '9004', startId: '9001',
    incomplete: false, count: 14, nextCursor: null,
  });
  // 超过一页也一次给全：不截成 10 条，也不由前端循环拼页。
  expect(result.data.items.map(item => item.id)).toEqual(
    Array.from({ length: 14 }, (_value, index) => String(9001 + index)));
  expect(requests.map(request => signature(request.url))).toEqual([
    '/api/archive/dynamics/1001/comments/5001/replies/9004/conversation',
  ]);
  expect(requests[0]!.init.method).toBe('GET');
  expect(requests[0]!.init.cache).toBe('no-store');
});

it('会话读取：404/非法身份是 not-found，其余失败可重试，页码或截断一律按失败处理', async () => {
  let requests = 0;
  const notFound = createArchiveReader(async () => {
    requests += 1;
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  });
  for (const item of [
    { dynamicId: 'x', rootId: '5001', replyId: '9004' },
    { dynamicId: '1001', rootId: '', replyId: '9004' },
    { dynamicId: '1001', rootId: '5001', replyId: '0x4' },
  ]) {
    expect(await notFound.readConversation({ ...item, signal: signal() })).toEqual({ status: 'not-found' });
  }
  expect(requests).toBe(0);
  expect(await notFound.readConversation({
    dynamicId: '1001', rootId: '5001', replyId: '9004', signal: signal(),
  })).toEqual({ status: 'not-found' });

  const failures: { status: number; body: unknown }[] = [
    { status: 503, body: { error: { code: 'STORAGE_UNAVAILABLE' } } },
    { status: 422, body: { error: { code: 'INVALID_INPUT' } } },
    // 旧后端按页码回包：`page` 键出现即不是整段响应，不能静默只显示 10 条。
    { status: 200, body: conversationBody({ page: 1 }) },
    { status: 200, body: conversationBody({ reply_id: '9005' }) },
    { status: 200, body: conversationBody({ root_id: '5002' }) },
    { status: 200, body: conversationBody({ start_id: '' }) },
    { status: 200, body: conversationBody({ incomplete: 'yes' }) },
    { status: 200, body: conversationBody({ count: null }) },
    { status: 200, body: conversationBody({ next_cursor: 'next' }) },
    // 服务端截断（条目少于 count）不是可接受的部分结果；重复 ID 同样拒绝。
    { status: 200, body: conversationBody({ items: [archiveReply(1), archiveReply(2)] }) },
    { status: 200, body: conversationBody({ items: Array.from({ length: 14 }, () => archiveReply(1)) }) },
  ];
  for (const item of failures) {
    const reader = createArchiveReader(async () => Response.json(item.body, { status: item.status }));
    expect(await reader.readConversation({
      dynamicId: '1001', rootId: '5001', replyId: '9004', signal: signal(),
    }), JSON.stringify(item.body)).toEqual({ status: 'error' });
  }

  const controller = new AbortController();
  controller.abort();
  expect(await notFound.readConversation({
    dynamicId: '1001', rootId: '5001', replyId: '9004', signal: controller.signal,
  })).toEqual({ status: 'cancelled' });
});
