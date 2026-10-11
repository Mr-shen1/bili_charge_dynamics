import { expect, it } from 'vitest';
import { createMockReader } from '../src/data/mockReader';

it('图片读取保留稳定标识、数组顺序和完整签名 URL，无效或缺失尺寸表达为未知', async () => {
  const creator = { id: 'up', nickname: '纸飞机', avatarUrl: null };
  const images = [
    { id: 'z', thumbnailUrl: '/demo-images/one.png?Signature=a%2Fb&Expires=123',
      previewUrl: 'https://oss.example.test/one.png?Signature=c%2Fd&Expires=456', width: 800, height: 600 },
    { id: 'a', thumbnailUrl: '/two.png', previewUrl: '/two-full.png', width: -1, height: NaN },
  ];
  const reader = createMockReader({ creator, dynamics: [{ id: 'post', author: creator,
    publishedAt: null, text: '', commentCount: 0, images }] });
  const result = await reader.readDetail({ id: 'post', signal: new AbortController().signal });
  expect(result).toEqual({ status: 'success', data: { id: 'post', author: creator,
    publishedAt: null, text: '', commentCount: 0,
    images: [images[0], { ...images[1], width: null, height: null }] } });
});
