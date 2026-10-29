import { expect, it } from 'vitest';
import type { Comment } from '../../src/data/contracts';
import type { ListSnapshot } from '../../src/app/snapshots';
import {
  adoptCommentSnapshot, emptyCommentSnapshot, listCommentRegionId, listCommentSnapshot,
} from '../../src/app/snapshots';

// 设计 §4：一级评论没有可恢复状态时默认按时间；快照存在时恢复原排序。
// 区域身份是读取与交互状态的键，不是 DOM id，也不存在唯一全局排序。

function comment(id: string): Comment {
  return {
    id,
    author: { id: '7001', nickname: '评论作者', avatarUrl: null },
    publishedAt: '2026-03-01T10:03:04+08:00',
    text: id,
    likeCount: 1,
    replyCount: 0,
  };
}

function readSnapshot(regionId: string, sort: 'hot' | 'latest') {
  return {
    ...emptyCommentSnapshot(sort),
    regionId,
    read: { status: 'success' as const, data: { items: [comment('c1')], nextCursor: 'c20' } },
  };
}

it('没有可恢复状态时一级评论默认按时间，而不是服务端的 hot 默认', () => {
  expect(emptyCommentSnapshot().sort).toBe('latest');
});

it('区域采纳属于自己的快照，恢复其中的排序与已读批次', () => {
  const own = readSnapshot('detail:1001', 'hot');
  expect(adoptCommentSnapshot(own, 'detail:1001')).toBe(own);
});

it('标着别的区域的快照不被采纳：不把别的区域的排序、批次与展开状态冒充成本区域的', () => {
  const foreign = readSnapshot('card:1001', 'hot');
  const adopted = adoptCommentSnapshot(foreign, 'detail:1001');
  expect(adopted).toEqual(emptyCommentSnapshot());
  expect(adopted.sort).toBe('latest');
  expect(adopted.read.data).toBeNull();
});

it('调用方给新区域的未标记快照可以采纳：详情入口不需要知道自己的区域身份', () => {
  const seed = { ...emptyCommentSnapshot('latest'),
    read: { status: 'success' as const, data: { items: [comment('seed')], nextCursor: null } } };
  expect(adoptCommentSnapshot(seed, 'detail:1001')).toBe(seed);
});

function listSnapshot(comments?: Record<string, ReturnType<typeof readSnapshot>>): ListSnapshot {
  return {
    read: { data: null, status: 'success' },
    expanded: {},
    position: null,
    ...(comments ? { comments } : {}),
  };
}

// 列表卡片内联评论是列表访问的快照内容：展开、排序、批次与回复页码都按卡片独立保存。
it('列表快照按卡片取回所属区域的评论状态，不借用别的卡片或详情区状态', () => {
  const own = readSnapshot(listCommentRegionId('1001'), 'hot');
  const snapshot = listSnapshot({ 1001: own, 1002: readSnapshot(listCommentRegionId('1002'), 'latest') });

  expect(listCommentSnapshot(snapshot, '1001')).toBe(own);
  expect(listCommentSnapshot(snapshot, '1002')?.sort).toBe('latest');
  expect(listCommentSnapshot(snapshot, '1003')).toBeUndefined();

  // 存着详情区状态的卡片快照不属于列表区域，不能冒充成卡片评论。
  const foreign = listSnapshot({ 1001: readSnapshot('detail:1001', 'hot') });
  expect(listCommentSnapshot(foreign, '1001')).toBeUndefined();
});

it('旧列表快照没有卡片评论字段时按未展开处理，不伪造已读状态', () => {
  expect(listCommentSnapshot(listSnapshot(), '1001')).toBeUndefined();
  expect(listCommentSnapshot(undefined, '1001')).toBeUndefined();
});
