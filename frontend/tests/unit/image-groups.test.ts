import { describe, expect, it } from 'vitest';
import { createArchiveReader } from '../../src/data/archiveReader';
import { previewGroup } from '../../src/preview/groups';
import { unavailablePlaceholderUrl } from '../../src/preview/assets';
import type { Dynamic } from '../../src/data/contracts';
import { archiveDetail } from '../fixtures/archive';

/**
 * Adapter 边界：生产 DTO 经真实归档读取映射后，预览连接层只按公开契约取图。
 * 这里不经过 mock 读取器，也不依赖 Element Plus 内部结构。
 */
function detailWithMedia(media: readonly Record<string, unknown>[]): Promise<Dynamic> {
  const reader = createArchiveReader(async () => Response.json(archiveDetail('1001', media)));
  return reader.readDetail({ id: '1001', signal: new AbortController().signal })
    .then(result => result.status === 'success' ? result.data : Promise.reject(new Error('读取失败')));
}

const owner = (type: 'dynamic' | 'comment', id: string) => ({ type, id });

describe('归档图片到预览组', () => {
  it('完整组保持数据顺序与 owner，并区分未上传、归档失败、无效公开地址', async () => {
    const dynamic = await detailWithMedia([
      { id: 'm-ready', owner: owner('dynamic', '1001'), status: 'success', public_url: 'https://cdn.example.test/a.jpg', width: 800, height: 600 },
      { id: 'm-pending', owner: owner('dynamic', '1001'), status: 'pending', public_url: null, width: null, height: null },
      { id: 'm-failed', owner: owner('dynamic', '1001'), status: 'failed', public_url: null, width: null, height: null },
      // 后端存了非公开/非 https 地址：读取层判为无效，不请求该地址。
      { id: 'm-invalid', owner: owner('dynamic', '1001'), status: 'success', public_url: 'http://insecure.example.test/b.jpg', width: null, height: null },
      // 成功状态却没有可用公开地址：同样是无效地址，不猜来源 URL。
      { id: 'm-missing', owner: owner('dynamic', '1001'), status: 'success', public_url: null, width: null, height: null },
      // 其他 owner 的图片不混入本组。
      { id: 'm-other', owner: owner('comment', '1001'), status: 'success', public_url: 'https://cdn.example.test/other.jpg', width: null, height: null },
      // 重复图片 ID 被读取层丢弃。
      { id: 'm-ready', owner: owner('dynamic', '1001'), status: 'success', public_url: 'https://cdn.example.test/duplicate.jpg', width: null, height: null },
    ]);

    expect(previewGroup({ type: 'dynamic', id: '1001' }, dynamic.images ?? [])).toEqual({
      id: 'dynamic-1001',
      label: '动态图片',
      owner: 'dynamic',
      images: [
        { id: 'm-ready', status: 'ready', thumbnailUrl: 'https://cdn.example.test/a.jpg', previewUrl: 'https://cdn.example.test/a.jpg' },
        { id: 'm-pending', status: 'pending', thumbnailUrl: null, previewUrl: unavailablePlaceholderUrl },
        { id: 'm-failed', status: 'failed', thumbnailUrl: null, previewUrl: unavailablePlaceholderUrl },
        { id: 'm-invalid', status: 'invalid', thumbnailUrl: null, previewUrl: unavailablePlaceholderUrl },
        { id: 'm-missing', status: 'invalid', thumbnailUrl: null, previewUrl: unavailablePlaceholderUrl },
      ],
    });
  });

  it('评论图片使用独立组标识与标签，不与动态组串位', () => {
    expect(previewGroup({ type: 'comment', id: '55' }, [{
      id: 'c-1', archiveStatus: 'success', thumbnailUrl: 'https://cdn.example.test/c-thumb.jpg',
      previewUrl: 'https://cdn.example.test/c-full.jpg', width: null, height: null,
    }])).toEqual({
      id: 'comment-55',
      label: '评论图片',
      owner: 'comment',
      images: [{
        id: 'c-1', status: 'ready', thumbnailUrl: 'https://cdn.example.test/c-thumb.jpg',
        previewUrl: 'https://cdn.example.test/c-full.jpg',
      }],
    });
  });

  it('空图片集得到空组，不伪造占位图片', () => {
    expect(previewGroup({ type: 'dynamic', id: '99' }, []).images).toEqual([]);
  });
});
