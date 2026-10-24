import type { Dynamic, DynamicImage, DynamicReader, ReadResult, User } from '../data/contracts';

// 仅供 mock/fault 装配：确定性 25 条动态，不访问真实 API，也不进入生产构建。
// 数据集在函数内构造，便于 Rollup 在普通构建里整体摇掉。
export function createMockArchiveReader(): DynamicReader {
  const first: User = { id: '123', nickname: '纸飞机', avatarUrl: null };
  const second: User = { id: '456', nickname: '另一位 UP', avatarUrl: null };
  const identities: readonly User[] = [first, second];
  const openingText = [
    '今天把小小的想法写在这里。🙂',
    '换一行，继续记录那些值得记住的瞬间。',
    `https://example.test/${'very-long-path-segment-'.repeat(8)}no-special-navigation`,
    '#日常记录# @朋友 都是普通文字，不会跳转。',
    '<script>window.__unsafeTextExecuted = true</script>',
    '<img src=x onerror=alert(1)>',
    '第七行：列表正文应该按实际行数折叠。',
    '第八行：这是一份虚构身份的本地文字动态演示。',
  ].join('\n');
  // 图片夹具：生产同址的缩略/预览在这里用不同路径，便于观察真实请求；
  // 状态覆盖成功、未上传、归档失败、无效公开地址与浏览器加载失败。数量只作夹具。
  const readyImage = (key: string, index: number, override: Partial<DynamicImage> = {}): DynamicImage => ({
    id: `${key}-${index + 1}`,
    archiveStatus: 'success',
    thumbnailUrl: `/images/thumb/${key}-${index + 1}.svg`,
    previewUrl: `/images/full/${key}-${index + 1}.svg`,
    width: 1200,
    height: 675,
    ...override,
  });
  const group = (key: string, size: number): DynamicImage[] =>
    Array.from({ length: size }, (_image, index) => readyImage(key, index));
  const longImage: DynamicImage = readyImage('archive-long', 0, {
    // 夹具服务器按 long 前缀返回 1200×6000 长图。
    thumbnailUrl: '/images/thumb/long-archive.svg',
    previewUrl: '/images/full/long-archive.svg',
    width: 1200,
    height: 6000,
  });
  const withoutUrl = (id: string, archiveStatus: 'pending' | 'failed' | 'success'): DynamicImage =>
    ({ id, archiveStatus, thumbnailUrl: null, previewUrl: null, width: null, height: null });
  const mixedImages: DynamicImage[] = [
    readyImage('archive-mixed', 0),
    withoutUrl('archive-mixed-2', 'pending'),
    withoutUrl('archive-mixed-3', 'failed'),
    // 成功状态但没有公开地址：连接层按无效公开地址表达，不请求来源。
    withoutUrl('archive-mixed-4', 'success'),
    // 浏览器加载失败：地址语法有效但服务端 503，可局部重试。
    readyImage('archive-mixed', 4, {
      thumbnailUrl: '/images/broken/archive-mixed-5.svg',
      previewUrl: '/images/broken/archive-mixed-5.svg',
    }),
    // 首次失败后重试成功：验证局部重试只重发既有公开地址。
    readyImage('archive-mixed', 5, {
      thumbnailUrl: '/images/thumb/archive-mixed-6.svg',
      previewUrl: '/images/flaky/archive-mixed-6.svg?failures=1',
    }),
  ];
  // 夹具索引 → 图片组；数量只作夹具，用于覆盖纯图/单图/4/9/12/长图与异常状态。
  const imageSets: Readonly<Record<number, readonly DynamicImage[]>> = {
    0: group('archive-quad', 4),
    1: group('archive-single', 1),
    2: group('archive-nine', 9),
    3: group('archive-many', 12),
    5: mixedImages,
    6: [longImage],
    7: group('archive-pair', 2),
  };

  const dynamics: Dynamic[] = Array.from({ length: 25 }, (_value, index) => ({
    id: `900719925474099${String(31 + index).padStart(2, '0')}`,
    author: index % 3 === 2 ? second : first,
    publishedAt: index === 4 ? null : new Date(Date.UTC(2026, 2, 1, 2, 3, 4) - index * 86400000).toISOString(),
    text: index === 0 ? openingText
      : index === 1 ? ''
      : index === 2 ? `长词 ${'a'.repeat(220)} 🙂`
      : index === 5 ? '这条归档没有评论'
      : `文字日记 ${index + 1}\n换行与 emoji 🙂 https://example.test/${'long-'.repeat(8)}`,
    commentCount: index === 0 ? 70 : index === 1 ? null : index === 5 ? 0 : index,
    images: imageSets[index] ?? [],
  })).sort((a, b) => {
    if (a.publishedAt !== b.publishedAt) {
      if (a.publishedAt === null) return 1;
      if (b.publishedAt === null) return -1;
      return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const cancelled = { status: 'cancelled' } as const;
  const failed = { status: 'error' } as const;

  return {
    creator: first,
    async readUps({ signal }): Promise<ReadResult<readonly User[]>> {
      return signal.aborted ? cancelled : { status: 'success', data: identities };
    },
    async readList({ scope, limit, cursor, signal }) {
      if (signal.aborted) return cancelled;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) return failed;
      if (scope.kind === 'up' && !identities.some(user => user.id === scope.upId)) {
        return { status: 'error', reason: 'unknown-up' };
      }
      const scoped = scope.kind === 'all' ? dynamics : dynamics.filter(item => item.author.id === scope.upId);
      const prefix = `mock-archive:${scope.kind === 'all' ? 'all' : scope.upId}:`;
      const offset = cursor == null ? 0 : cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : Number.NaN;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > scoped.length) {
        return { status: 'error', reason: 'invalid-cursor' };
      }
      return {
        status: 'success',
        data: {
          items: scoped.slice(offset, offset + limit),
          nextCursor: offset + limit < scoped.length ? `${prefix}${offset + limit}` : null,
        },
      };
    },
    async readDetail({ id, signal }) {
      if (signal.aborted) return cancelled;
      const item = dynamics.find(dynamic => dynamic.id === id);
      return item ? { status: 'success', data: item } : { status: 'not-found' };
    },
    async readComments({ signal }) {
      return signal.aborted ? cancelled : failed;
    },
    async readReplies({ signal }) {
      return signal.aborted ? cancelled : failed;
    },
  };
}
