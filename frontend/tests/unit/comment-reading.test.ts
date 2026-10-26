import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CommentBatch, CommentSort, DynamicReader, ReadResult } from '../../src/data/contracts';
import { comment, commentArchive, comments, commentDynamic, targetCheck } from '../fixtures/comments';
import { createReader, deferred } from '../support/reader';
import { showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';

let layout: FakeLayout;
beforeEach(() => { layout = installFakeLayout(); });
afterEach(() => {
  cleanup();
  layout.restore();
});

function requests() {
  const seen: { sort: CommentSort; cursor: string | null | undefined }[] = [];
  return seen;
}

it('无会话新访问的详情默认按最热读取首批 20 条，置顶标识来自服务端顺序', async () => {
  const seen = requests();
  const first = comments(20).map((item, index) => index === 0 ? { ...item, isPinned: true } : item);
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => {
      seen.push({ sort: input.sort, cursor: input.cursor });
      return { status: 'success', data: { items: first, nextCursor: 'cursor-20' } };
    },
  });

  await showApp(reader, '/dynamics/1001');

  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  expect(seen).toEqual([{ sort: 'hot', cursor: undefined }]);
  const hot = within(region).getByRole('radio', { name: '最热' }) as HTMLInputElement;
  const latest = within(region).getByRole('radio', { name: '最新' }) as HTMLInputElement;
  expect([hot.checked, latest.checked]).toEqual([true, false]);
  const items = within(region).getAllByRole('listitem');
  expect(items[0]!.textContent).toContain('置顶');
  expect(items[1]!.textContent).not.toContain('置顶');
  expect(items[0]!.getAttribute('data-reading-id')).toBe(`comment:${comment(1).id}`);
});

it('一级评论按 20/20/5 cursor 追加，结束后不再请求也不恢复结语', async () => {
  const seen: (string | null | undefined)[] = [];
  const all = comments(45);
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => {
      seen.push(input.cursor);
      const offset = input.cursor === undefined ? 0 : input.cursor === 'c20' ? 20 : 40;
      const end = Math.min(offset + 20, all.length);
      return {
        status: 'success',
        data: { items: all.slice(offset, end), nextCursor: end < all.length ? `c${end}` : null },
      };
    },
  });

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));

  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(40));
  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(45));

  expect(seen).toEqual([undefined, 'c20', 'c40']);
  expect(within(region).queryByRole('button', { name: '加载更多评论' })).toBeNull();
  expect(region.textContent).not.toContain('加载完毕');
  expect(region.textContent).not.toContain('已读完');
  const ids = within(region).getAllByRole('listitem').map(item => item.getAttribute('data-reading-id'));
  expect(ids).toEqual(all.map(item => `comment:${item.id}`));
});

it('追加失败保留已读内容，重试沿用同一 cursor，双击不重复发请求', async () => {
  const seen: (string | null | undefined)[] = [];
  const second = deferred<ReadResult<CommentBatch>>();
  const all = comments(40);
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => {
      seen.push(input.cursor);
      if (input.cursor === undefined) {
        return { status: 'success', data: { items: all.slice(0, 20), nextCursor: 'c20' } };
      }
      if (seen.filter(cursor => cursor === 'c20').length === 1) return second.promise;
      return { status: 'success', data: { items: all.slice(20), nextCursor: null } };
    },
  });

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  const append = await within(region).findByRole('button', { name: '加载更多评论' });
  // 同一批的重复触发只能发一次请求（请求进行中不再接受新批次）。
  await fireEvent.click(append);
  await fireEvent.click(append);
  await waitFor(() => expect(seen).toEqual([undefined, 'c20']));

  second.resolve({ status: 'error' });
  expect(await within(region).findByRole('alert')).toHaveProperty(
    'textContent', '最热评论追加读取失败，请重试。');
  // 失败不推进 cursor，也不丢掉已读的 20 条。
  expect(within(region).getAllByRole('listitem')).toHaveLength(20);
  await fireEvent.click(within(region).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(40));
  expect(seen).toEqual([undefined, 'c20', 'c20']);
  expect(within(region).queryByRole('alert')).toBeNull();
});

it('切换排序重置为目标排序首批，不沿用旧排序的分页进度', async () => {
  const seen: { sort: CommentSort; cursor: string | null | undefined }[] = [];
  const hotItems = comments(40);
  const latestItems = Array.from({ length: 12 }, (_value, index) => comment(100 + index));
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => {
      seen.push({ sort: input.sort, cursor: input.cursor });
      if (input.sort === 'hot') {
        const offset = input.cursor === 'c20' ? 20 : 0;
        return { status: 'success', data: { items: hotItems.slice(offset, offset + 20), nextCursor: offset === 0 ? 'c20' : null } };
      }
      return { status: 'success', data: { items: latestItems, nextCursor: 'l12' } };
    },
  });

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(40));

  await fireEvent.click(within(region).getByRole('radio', { name: '最新' }));

  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(12));
  // 切换先定位评论区，再读目标排序首批（cursor 为空，不带旧进度）。
  expect(seen).toEqual([
    { sort: 'hot', cursor: undefined },
    { sort: 'hot', cursor: 'c20' },
    { sort: 'latest', cursor: undefined },
  ]);
  expect(within(region).getAllByRole('listitem').map(item => item.getAttribute('data-reading-id')))
    .toEqual(latestItems.map(item => `comment:${item.id}`));
  const latest = within(region).getByRole('radio', { name: '最新' }) as HTMLInputElement;
  const hot = within(region).getByRole('radio', { name: '最热' }) as HTMLInputElement;
  expect([latest.checked, hot.checked]).toEqual([true, false]);
});

it('点击已在用的排序不重置也不重复请求', async () => {
  const seen: (string | null | undefined)[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => {
      seen.push(input.cursor);
      return { status: 'success', data: { items: comments(20), nextCursor: 'c20' } };
    },
  });
  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  await fireEvent.click(within(region).getByRole('radio', { name: '最热' }));
  await Promise.resolve();
  expect(seen).toEqual([undefined]);
  expect(within(region).getAllByRole('listitem')).toHaveLength(20);
});

for (const outcome of ['success', 'error', 'reject'] as const) {
  it(`快速切换排序时旧排序迟到的 ${outcome} 不污染最后选择`, async () => {
    const hot = deferred<ReadResult<CommentBatch>>();
    const latest = deferred<ReadResult<CommentBatch>>();
    const reader = createReader({
      readDetail: async () => ({ status: 'success', data: commentDynamic() }),
      readComments: async input => (input.sort === 'hot' ? hot.promise : latest.promise),
    });

    await showApp(reader, '/dynamics/1001');
    const region = await screen.findByRole('region', { name: '评论区' });
    await fireEvent.click(within(region).getByRole('radio', { name: '最新' }));

    if (outcome === 'success') {
      hot.resolve({ status: 'success', data: { items: comments(20), nextCursor: null } });
    } else if (outcome === 'error') {
      hot.resolve({ status: 'error' });
    } else {
      hot.reject(new Error('late hot failure'));
    }
    await Promise.resolve();
    await Promise.resolve();

    // 旧排序的结果/失败/拒绝都不能解除新排序的加载态或写入条目。
    expect(within(region).queryAllByRole('listitem')).toHaveLength(0);
    expect(within(region).getByText('最新评论加载中…')).toBeTruthy();
    expect(within(region).queryByRole('alert')).toBeNull();
    expect((within(region).getByRole('radio', { name: '最新' }) as HTMLInputElement).checked).toBe(true);

    latest.resolve({ status: 'success', data: { items: comments(5), nextCursor: null } });
    await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(5));
    expect(region.textContent).not.toContain('一级评论 6');
    expect(within(region).queryByRole('alert')).toBeNull();
  });
}

function listWithDetail(): Partial<DynamicReader> {
  return {
    readUps: async () => ({ status: 'success', data: [] }),
    readList: async () => ({ status: 'success', data: { items: [commentDynamic()], nextCursor: null } }),
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
  };
}

it('历史返回恢复排序、已读批次与 cursor，继续追加不重读首批', async () => {
  const seen: { sort: CommentSort; cursor: string | null | undefined }[] = [];
  const reader = createReader({
    ...listWithDetail(),
    readComments: async input => {
      seen.push({ sort: input.sort, cursor: input.cursor });
      if (input.sort === 'hot') {
        const offset = input.cursor === 'c20' ? 20 : 0;
        return { status: 'success', data: { items: comments(45).slice(offset, offset + 20), nextCursor: offset === 0 ? 'c20' : 'c40' } };
      }
      const first = Array.from({ length: 12 }, (_value, index) => comment(200 + index));
      if (input.cursor === 'l12') {
        return { status: 'success', data: { items: Array.from({ length: 5 }, (_value, index) => comment(400 + index)), nextCursor: null } };
      }
      return { status: 'success', data: { items: first, nextCursor: 'l12' } };
    },
  });
  const router = await showApp(reader);
  await screen.findByText('详情正文');
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(40));
  await fireEvent.click(within(region).getByRole('radio', { name: '最新' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(12));

  layout.setScrollY(500);
  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));

  const requestsBeforeRestore = seen.length;
  await router.go(1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const restored = await screen.findByRole('region', { name: '评论区' });
  expect(within(restored).getAllByRole('listitem')).toHaveLength(12);
  expect((within(restored).getByRole('radio', { name: '最新' }) as HTMLInputElement).checked).toBe(true);
  // 恢复已读内容不重复请求首批。
  expect(seen).toHaveLength(requestsBeforeRestore);
  await waitFor(() => expect(layout.scrollY()).toBe(500));

  await fireEvent.click(within(restored).getByRole('button', { name: '加载更多评论' }));
  await waitFor(() => expect(within(restored).getAllByRole('listitem')).toHaveLength(17));
  expect(seen.at(-1)).toEqual({ sort: 'latest', cursor: 'l12' });
});

it('评论入口进入同页详情并重建讨论状态，不沿用旧阅读位置', async () => {
  const reader = createReader({
    ...listWithDetail(),
    readComments: async () => ({ status: 'success', data: { items: comments(20), nextCursor: null } }),
  });
  const router = await showApp(reader);
  await screen.findByText('详情正文');

  // 先制造一次旧阅读位置：进入详情后滚到正文深处，再返回。
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await screen.findByRole('region', { name: '评论区' });
  layout.setScrollY(700);
  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));

  await fireEvent.click(screen.getByRole('button', { name: '来源评论 45' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  // 新访问重新读最热首批，且不回到旧访问的 700px 位置。
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  expect((within(region).getByRole('radio', { name: '最热' }) as HTMLInputElement).checked).toBe(true);
  expect(layout.scrollY()).not.toBe(700);
});

it('同一动态的多次访问各自保留排序与批次，互不覆盖', async () => {
  const seen: { sort: CommentSort; cursor: string | null | undefined }[] = [];
  const reader = createReader({
    ...listWithDetail(),
    readComments: async input => {
      seen.push({ sort: input.sort, cursor: input.cursor });
      if (input.sort === 'hot') {
        const offset = input.cursor === 'c20' ? 20 : 0;
        return { status: 'success', data: { items: comments(40).slice(offset, offset + 20), nextCursor: offset === 0 ? 'c20' : null } };
      }
      return { status: 'success', data: { items: Array.from({ length: 8 }, (_value, index) => comment(300 + index)), nextCursor: null } };
    },
  });
  const router = await showApp(reader);
  await screen.findByText('详情正文');

  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const first = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(first).getAllByRole('listitem')).toHaveLength(20));
  await fireEvent.click(within(first).getByRole('button', { name: '加载更多评论' }));
  await waitFor(() => expect(within(first).getAllByRole('listitem')).toHaveLength(40));
  layout.setScrollY(600);

  // 与主题入口相同：新列表记录，保留第一次详情访问。
  await router.push('/');
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  await fireEvent.click(await screen.findByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const second = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(second).getAllByRole('listitem')).toHaveLength(20));
  expect(layout.scrollY()).toBe(0);

  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const restored = await screen.findByRole('region', { name: '评论区' });
  expect(within(restored).getAllByRole('listitem')).toHaveLength(40);
  await waitFor(() => expect(layout.scrollY()).toBe(600));

  await router.go(1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  await router.go(1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  expect(within(await screen.findByRole('region', { name: '评论区' })).getAllByRole('listitem')).toHaveLength(20);
});

it('成功空与未完成同步区分：确认同步后才显示暂无评论', async () => {
  const emptyDouble = (work: 'success' | 'pending', attempt: 'success' | 'failed' | 'pending' | 'unconfirmed' = work) => {
    return createReader({
      readDetail: async () => ({
        status: 'success',
        data: commentDynamic({
          commentCount: 0,
          archive: commentArchive({
            work: { text: 'success', media: 'success', comments: work },
            rootCommentsLastAttempt: attempt,
          }),
        }),
      }),
      readComments: async () => ({ status: 'success', data: { items: [], nextCursor: null } }),
    });
  };

  await showApp(emptyDouble('success', 'success'), '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getByText('暂无评论')).toBeTruthy());
  expect(region.textContent).not.toContain('评论尚未归档');

  cleanup();
  await showApp(emptyDouble('pending'), '/dynamics/1001');
  const pending = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(pending).getByText('评论尚未归档；来源计数不代表本地已有评论。')).toBeTruthy());
  expect(within(pending).queryByText('暂无评论')).toBeNull();

  cleanup();
  await showApp(emptyDouble('success', 'failed'), '/dynamics/1001');
  const failedSync = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(failedSync).getByText('评论尚未归档；来源计数不代表本地已有评论。')).toBeTruthy());
});

it('读取失败可在评论区重试，取消不被当作失败', async () => {
  let attempts = 0;
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => {
      attempts += 1;
      if (attempts === 1) return { status: 'error' };
      if (attempts === 2) return { status: 'cancelled' };
      return { status: 'success', data: { items: comments(3), nextCursor: null } };
    },
  });
  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  expect((await within(region).findByRole('alert')).textContent).toBe('最热评论读取失败，请重试。');
  // 失败只影响评论区：详情正文仍在。
  expect(screen.getByText('详情正文')).toBeTruthy();

  await fireEvent.click(within(region).getByRole('button', { name: '重试' }));
  expect(await within(region).findByText('读取已取消，可重新读取。')).toBeTruthy();
  expect(within(region).queryByRole('alert')).toBeNull();

  await fireEvent.click(within(region).getByRole('button', { name: '重新读取' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(3));
});

it('失效 cursor 保留已读内容，重新开始读取丢弃旧批次并重读首批', async () => {
  const seen: (string | null | undefined)[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => {
      seen.push(input.cursor);
      if (input.cursor === 'stale') return { status: 'error', reason: 'invalid-cursor' };
      if (input.cursor === undefined && seen.length > 1) {
        return { status: 'success', data: { items: comments(4), nextCursor: null } };
      }
      return { status: 'success', data: { items: comments(20), nextCursor: 'stale' } };
    },
  });
  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));

  expect((await within(region).findByRole('alert')).textContent).toBe('评论读取标记无效，请重新开始读取。');
  expect(within(region).getAllByRole('listitem')).toHaveLength(20);
  expect(within(region).queryByText(/加载完毕|已读完/)).toBeNull();

  await fireEvent.click(within(region).getByRole('button', { name: '重新开始读取' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(4));
  expect(seen).toEqual([undefined, 'stale', undefined]);
});

it('正文受限不影响评论读取', async () => {
  const reader = createReader({
    readDetail: async () => ({
      status: 'success',
      data: commentDynamic({
        text: '',
        archive: commentArchive({ contentState: 'restricted', lastAttempt: 'restricted' }),
      }),
    }),
    readComments: async () => ({ status: 'success', data: { items: comments(2), nextCursor: null } }),
  });
  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(2));
  expect(screen.queryByText('暂无内容')).toBeNull();
});

it('一级评论按作者 ID 标注 UP、安全渲染文本，计数与时间缺失不回填', async () => {
  const malicious = '<script>window.pwned = true</script> https://example.test/x';
  const items = [
    comment(1, { author: { id: '123', nickname: '动态作者', avatarUrl: null }, isPinned: true }),
    comment(2, {
      author: { id: '999', nickname: '动态作者', avatarUrl: null },
      publishedAt: null,
      likeCount: null,
      replyCount: null,
      text: malicious,
    }),
    comment(3, { replyCount: 0, likeCount: 0 }),
    { ...comment(4), text: '', images: [], pendingMediaCount: 2 },
  ];
  const reader = createReader({
    readDetail: async () => ({
      status: 'success',
      data: commentDynamic({
        commentCount: 50,
        archive: commentArchive({ commentSync: targetCheck({ sourceCommentCount: 45 }) }),
      }),
    }),
    readComments: async () => ({ status: 'success', data: { items, nextCursor: null } }),
  });
  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(4));
  // 标题计数优先最新检查状态中的来源总数。
  expect(within(region).getByRole('button', { name: '来源评论 45' })).toBeTruthy();
  expect(region.textContent).toContain('评论 45');

  const list = within(region).getAllByRole('listitem');
  expect(list[0]!.textContent).toContain('UP主');
  expect(list[0]!.textContent).toContain('置顶');
  // 同名但作者 ID 不同不能冒充 UP。
  expect(list[1]!.textContent).not.toContain('UP主');
  expect(list[1]!.textContent).toContain('时间未知');
  expect(within(list[1]!).getByRole('group', { name: '点赞 —' })).toBeTruthy();
  expect(list[1]!.textContent).toContain('回复 —');
  expect(list[1]!.textContent).toContain(malicious);
  expect(list[1]!.querySelector('script')).toBeNull();
  expect(list[1]!.querySelector('a')).toBeNull();
  expect(list[2]!.textContent).toContain('回复 0');
  expect(within(list[2]!).getByRole('group', { name: '点赞 0' })).toBeTruthy();
  const like = within(list[2]!).getByRole('group', { name: '点赞 0' });
  expect(like.querySelector('button, a')).toBeNull();
  // 纯图评论不写“暂无评论内容”，只提示待归档数量。
  expect(list[3]!.textContent).not.toContain('暂无评论内容');
  expect(list[3]!.textContent).toContain('评论图片待归档（2 张）');

  expect(document.body.textContent).not.toContain('归档状态');
  expect(document.body.textContent).not.toContain('读取评论同步状态');
  expect(document.body.textContent).not.toContain('编辑');
});

it('无正文也无图片的评论显示暂无评论内容', async () => {
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => ({
      status: 'success',
      data: { items: [{ ...comment(1), text: '', images: [], pendingMediaCount: 0 }], nextCursor: null },
    }),
  });
  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getByText('暂无评论内容')).toBeTruthy());
});

it('跨批重复的评论按 ID 去重，不重复展示', async () => {
  const all = comments(40);
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => input.cursor === undefined
      ? { status: 'success', data: { items: all.slice(0, 20), nextCursor: 'c20' } }
      // 服务端重复上一批末条：页面仍按 ID 去重，不出现两条相同评论。
      : { status: 'success', data: { items: all.slice(19, 40), nextCursor: null } },
  });
  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));
  // 21 条响应含 1 条重复：新展示 20 条，总计 40 条且无重复。
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(40));
  const ids = within(region).getAllByRole('listitem').map(item => item.getAttribute('data-reading-id'));
  expect(new Set(ids).size).toBe(40);
});

it('离开未完成的追加读取再返回，从原 cursor 继续且不遗留永久加载态', async () => {
  const seen: (string | null | undefined)[] = [];
  const pending = deferred<ReadResult<CommentBatch>>();
  const all = comments(40);
  const reader = createReader({
    ...listWithDetail(),
    readComments: async input => {
      seen.push(input.cursor);
      if (input.cursor === undefined) {
        return { status: 'success', data: { items: all.slice(0, 20), nextCursor: 'c20' } };
      }
      if (seen.filter(cursor => cursor === 'c20').length === 1) return pending.promise;
      return { status: 'success', data: { items: all.slice(20), nextCursor: null } };
    },
  });
  const router = await showApp(reader);
  await screen.findByText('详情正文');
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));
  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));

  await router.go(1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const restored = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(restored).getAllByRole('listitem')).toHaveLength(40));
  // 旧的挂起请求被取消；返回后从保存的 cursor 续读，而不是重读首批。
  pending.resolve({ status: 'success', data: { items: all.slice(20), nextCursor: null } });
  await Promise.resolve();
  expect(seen).toEqual([undefined, 'c20', 'c20']);
  expect(within(restored).queryByText('最热评论追加加载中…')).toBeNull();
  expect(within(restored).queryByRole('alert')).toBeNull();
});

it('读取器声明不具备讨论能力时显示未归档且不发评论请求', async () => {
  let calls = 0;
  const reader = createReader({
    discussions: 'not-archived',
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => {
      calls += 1;
      return { status: 'success', data: { items: comments(2), nextCursor: null } };
    },
  });
  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  expect(within(region).getByText('评论尚未归档；来源计数不代表本地已有评论。')).toBeTruthy();
  // 未归档不显示排序组，也不读取评论。
  expect(within(region).queryByRole('radio')).toBeNull();
  expect(within(region).queryAllByRole('listitem')).toHaveLength(0);
  expect(calls).toBe(0);
});

/** jsdom 没有 scrollIntoView：记录被定位的元素，验证定位落在目标评论而不是评论区顶部。 */
function recordScrollIntoView(): Element[] {
  const scrolled: Element[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: Element) { scrolled.push(this); },
  });
  return scrolled;
}

const longComment = Array.from({ length: 7 }, (_value, line) =>
  `第七行边界 ${line + 1}：这是一段足够长的评论正文，用于验证定位后默认展开。`).join('\n');

it('直开一级评论定位链接：按目标身份取定位批次、展开正文、高亮目标并续读定位窗口', async () => {
  const scrolled = recordScrollIntoView();
  const all = comments(45);
  const target = { ...all[24]!, text: longComment };
  const located: { rootId: string; sort: CommentSort }[] = [];
  const reads: (string | null | undefined)[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => {
      reads.push(input.cursor);
      return { status: 'success', data: { items: all.slice(0, 20), nextCursor: 'first-page-20' } };
    },
    locateComment: async input => {
      located.push({ rootId: input.rootId, sort: input.sort });
      return { status: 'success', data: { items: [target, ...all.slice(25, 39)], nextCursor: 'located-40' } };
    },
  });

  await showApp(reader, `/dynamics/1001/comments/${target.id}/locate`);
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(15));

  // 只按目标身份取定位批次，不先读首批，也不因定位渲染全部评论。
  expect(located).toEqual([{ rootId: target.id, sort: 'hot' }]);
  expect(reads).toEqual([]);
  const first = within(region).getAllByRole('listitem')[0]!;
  expect(first.getAttribute('data-reading-id')).toBe(`comment:${target.id}`);
  expect(first.getAttribute('data-located')).toBe('true');
  expect(within(region).getAllByRole('listitem').filter(item => item.getAttribute('data-located') === 'true')).toHaveLength(1);
  // 定位落在目标评论本身，不是评论区顶部。
  expect(scrolled.at(-1)).toBe(first);

  // 续读沿用定位窗口的 cursor，不回退到首批 cursor。
  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));
  await waitFor(() => expect(reads).toEqual(['located-40']));
});

it('定位目标不存在时明确提示并可返回动态，不请求普通分页也不把页首当成功', async () => {
  const reads: unknown[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => {
      reads.push(input.cursor);
      return { status: 'success', data: { items: comments(20), nextCursor: 'c20' } };
    },
    locateComment: async () => ({ status: 'not-found' }),
  });

  const router = await showApp(reader, '/dynamics/1001/comments/9999/locate');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getByRole('status').textContent).toContain('不存在或未归档'));
  expect(within(region).queryAllByRole('listitem')).toHaveLength(0);
  expect(reads).toEqual([]);

  await fireEvent.click(within(region).getByRole('button', { name: '返回动态' }));
  await waitFor(() => expect(router.currentRoute.value.path).toBe('/dynamics/1001'));
});

it('定位临时失败可局部重试，重试成功后才高亮目标', async () => {
  recordScrollIntoView();
  let attempts = 0;
  const target = comment(24);
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    locateComment: async () => {
      attempts += 1;
      if (attempts === 1) return { status: 'error' };
      return { status: 'success', data: { items: [target], nextCursor: null } };
    },
  });

  await showApp(reader, `/dynamics/1001/comments/${target.id}/locate`);
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getByRole('alert').textContent).toContain('读取失败'));
  expect(within(region).queryAllByRole('listitem')).toHaveLength(0);

  await fireEvent.click(within(region).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(1));
  expect(attempts).toBe(2);
  expect(within(region).getAllByRole('listitem')[0]!.getAttribute('data-located')).toBe('true');
});

it('用户已滚动时迟到的定位结果不抢回位置，仍高亮目标', async () => {
  const scrolled = recordScrollIntoView();
  const target = comment(24);
  const pending = deferred<Awaited<ReturnType<DynamicReader['locateComment']>>>();
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    locateComment: async () => pending.promise,
  });

  await showApp(reader, `/dynamics/1001/comments/${target.id}/locate`);
  const region = await screen.findByRole('region', { name: '评论区' });
  // 用户主动滚动（滚轮）后，迟到的定位批次不得再把视口拉回目标。
  await fireEvent.wheel(window);
  pending.resolve({ status: 'success', data: { items: [target], nextCursor: null } });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(1));
  expect(within(region).getAllByRole('listitem')[0]!.getAttribute('data-located')).toBe('true');
  expect(scrolled).toEqual([]);
});

it('切换定位链接时另一条访问的迟到响应不覆盖当前目标', async () => {
  recordScrollIntoView();
  const first = comment(24);
  const second = comment(30);
  const pending = deferred<Awaited<ReturnType<DynamicReader['locateComment']>>>();
  const requested: string[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    locateComment: async input => {
      requested.push(input.rootId);
      return input.rootId === first.id
        ? pending.promise
        : { status: 'success', data: { items: [second], nextCursor: null } };
    },
  });

  const router = await showApp(reader, `/dynamics/1001/comments/${first.id}/locate`);
  await waitFor(() => expect(requested).toEqual([first.id]));
  await router.push(`/dynamics/1001/comments/${second.id}/locate`);
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(1));
  expect(within(region).getAllByRole('listitem')[0]!.getAttribute('data-reading-id')).toBe(`comment:${second.id}`);

  pending.resolve({ status: 'success', data: { items: [first], nextCursor: null } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(within(region).getAllByRole('listitem')).toHaveLength(1);
  expect(within(region).getAllByRole('listitem')[0]!.getAttribute('data-reading-id')).toBe(`comment:${second.id}`);
  expect(within(region).getAllByRole('listitem')[0]!.getAttribute('data-located')).toBe('true');
});

it('定位视图可以先读目标之前的评论：提示更早条数、插入到最前面且不覆盖后向游标', async () => {
  const all = comments(45);
  const target = all[24]!;
  const reads: (string | null | undefined)[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => {
      reads.push(input.cursor);
      return { status: 'success', data: {
        items: all.slice(4, 24), nextCursor: null, prevCursor: 'back-4', earlierCount: 4,
      } };
    },
    locateComment: async () => ({ status: 'success', data: {
      items: all.slice(24, 44), nextCursor: 'located-44', prevCursor: 'back-24', earlierCount: 24,
    } }),
  });

  await showApp(reader, `/dynamics/1001/comments/${target.id}/locate`);
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  expect(within(region).getByText('以上还有 24 条更早评论')).toBeTruthy();

  await fireEvent.click(within(region).getByRole('button', { name: '加载更早评论' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(40));
  // 只按向前游标读取，不重开定位、不回到首批。
  expect(reads).toEqual(['back-24']);
  const items = within(region).getAllByRole('listitem');
  expect(items[0]!.getAttribute('data-reading-id')).toBe(`comment:${all[4]!.id}`);
  expect(items[19]!.getAttribute('data-reading-id')).toBe(`comment:${all[23]!.id}`);
  expect(items[20]!.getAttribute('data-reading-id')).toBe(`comment:${target.id}`);
  expect(items[20]!.getAttribute('data-located')).toBe('true');
  expect(within(region).getByText('以上还有 4 条更早评论')).toBeTruthy();

  // 后向游标仍是定位窗口给的，不被向前读取的响应覆盖。
  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));
  await waitFor(() => expect(reads).toEqual(['back-24', 'located-44']));
});

it('更早评论读取失败时保留已读批次并给出可重试提示', async () => {
  const all = comments(45);
  const target = all[24]!;
  let fail = true;
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => (fail
      ? { status: 'error' }
      : { status: 'success', data: { items: all.slice(0, 24), nextCursor: null, prevCursor: null, earlierCount: 0 } }),
    locateComment: async () => ({ status: 'success', data: {
      items: all.slice(24, 44), nextCursor: null, prevCursor: 'back-24', earlierCount: 24,
    } }),
  });

  await showApp(reader, `/dynamics/1001/comments/${target.id}/locate`);
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  await fireEvent.click(within(region).getByRole('button', { name: '加载更早评论' }));
  await waitFor(() => expect(within(region).getByRole('alert').textContent).toContain('更早评论读取失败'));
  expect(within(region).getAllByRole('listitem')).toHaveLength(20);
  expect(within(region).getByText('以上还有 24 条更早评论')).toBeTruthy();

  fail = false;
  await fireEvent.click(within(region).getByRole('button', { name: '加载更早评论' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(44));
  expect(within(region).queryByText(/以上还有/)).toBeNull();
});
