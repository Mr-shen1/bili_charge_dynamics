import type { ArchiveMetadata, Comment, Dynamic, DynamicImage, DynamicReader, ReadResult, Reply, User } from '../data/contracts';
import { replyAppendSize, replyPreviewSize } from '../data/contracts';

// 仅供 mock/fault 装配：确定性 25 条动态，不访问真实 API，也不进入生产构建。
// 数据集在函数内构造，便于 Rollup 在普通构建里整体摇掉。
export function createMockArchiveReader(): DynamicReader {
  const first: User = { id: '123', nickname: '纸飞机', avatarUrl: null };
  const second: User = { id: '456', nickname: '另一位 UP', avatarUrl: null };
  const identities: readonly User[] = [first, second];
  const third: User = { id: '789', nickname: null, avatarUrl: null };

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
  // 夹具服务器按 long 前缀返回 1200×6000 长图。
  const longImage = (key: string): DynamicImage => readyImage(key, 0, {
    thumbnailUrl: `/images/thumb/long-${key}.svg`,
    previewUrl: `/images/full/long-${key}.svg`,
    width: 1200,
    height: 6000,
  });
  const withoutUrl = (id: string, archiveStatus: 'pending' | 'failed' | 'success'): DynamicImage =>
    ({ id, archiveStatus, thumbnailUrl: null, previewUrl: null, width: null, height: null });
  // 动态与评论共用同一种混合状态组，只换 key：两者的 owner 隔离不由夹具地址决定。
  const mixedGroup = (key: string): DynamicImage[] => [
    readyImage(key, 0),
    withoutUrl(`${key}-2`, 'pending'),
    withoutUrl(`${key}-3`, 'failed'),
    // 成功状态但没有公开地址：连接层按无效公开地址表达，不请求来源。
    withoutUrl(`${key}-4`, 'success'),
    // 浏览器加载失败：地址语法有效但服务端 503，可局部重试。
    readyImage(key, 4, {
      thumbnailUrl: `/images/broken/${key}-5.svg`,
      previewUrl: `/images/broken/${key}-5.svg`,
    }),
    // 首次失败后重试成功：验证局部重试只重发既有公开地址。
    readyImage(key, 5, {
      thumbnailUrl: `/images/thumb/${key}-6.svg`,
      previewUrl: `/images/flaky/${key}-6.svg?failures=1`,
    }),
  ];

  // 一级评论夹具：45 条，覆盖最热/最新排序、来源置顶、6/7 行折叠边界、
  // 缺字段兜底、纯图/无正文与安全文本；只挂在第一条动态上。
  // 评论图片按根评论各自成组：混合状态、单张长图、纯图四张与超过九张分别落在 0/1/2/5 号。
  const commentLong = Array.from({ length: 7 }, (_value, line) =>
    `第七行边界 ${line + 1}：这是一段足够长的评论正文，用于验证实际超过六行才折叠。`).join('\n');
  const commentSix = Array.from({ length: 6 }, (_value, line) =>
    `第六行边界 ${line + 1}：同样长度的正文，但恰好六行不应出现展开入口。`).join('\n');
  const commentFacets: Readonly<Record<number, { images?: readonly DynamicImage[]; pendingMediaCount?: number }>> = {
    0: { images: mixedGroup('comment-mixed') },
    1: { images: [longImage('comment')] },
    2: { images: group('comment-quad', 4) },
    // 来源存在但没有当前关联的旧评论仍单独表达待归档数量，不伪造成图片项。
    4: { pendingMediaCount: 1 },
    5: { images: group('comment-many', 12) },
  };
  const rootComments: Comment[] = Array.from({ length: 45 }, (_value, index) => ({
    id: `900719925474010${String(1 + index).padStart(2, '0')}`,
    isPinned: index === 0 || index === 2,
    author: index % 7 === 0 ? first : index % 11 === 0 ? { id: '', nickname: null, avatarUrl: null } : third,
    publishedAt: index === 3 ? null : new Date(Date.UTC(2026, 2, 1, 2, 3, 4) - index * 3600_000).toISOString(),
    text: index === 0 ? commentLong
      : index === 1 ? commentSix
      : index === 2 ? ''
      : index === 4 ? '<script>window.__commentUnsafe = true</script> https://example.test/comment'
      : `一级评论 ${index + 1}\n第二行：换行与 emoji 🙂`,
    likeCount: index % 13 === 0 ? null : (index * 37) % 23,
    replyCount: index === 0 ? 25 : index % 5,
    images: commentFacets[index]?.images ?? [],
    pendingMediaCount: commentFacets[index]?.pendingMediaCount ?? 0,
  }));

  // 视觉与状态夹具：确认空、未完成同步、受限正文；其余动态使用确认成功的空评论集。
  const commentArchive = (overrides: Partial<ArchiveMetadata> = {}): ArchiveMetadata => ({
    title: null, editedAt: null, editStatus: 'unknown', contentState: 'success', lastAttempt: 'success',
    localCommentCount: 0, rootCommentsLastAttempt: 'success', commentsLastAttempt: 'success',
    mediaSources: [], commentLocator: null, observedVersion: null, syncedVersion: null,
    work: { text: 'success', media: 'success', comments: 'success' }, ...overrides,
  });
  const commentArchiveFacets: Record<number, ArchiveMetadata> = {
    0: commentArchive({ localCommentCount: 45 }),
    5: commentArchive({ rootCommentsLastAttempt: 'success' }),
    6: commentArchive({ rootCommentsLastAttempt: 'pending', work: { text: 'success', media: 'success', comments: 'pending' } }),
    7: commentArchive({ contentState: 'restricted', lastAttempt: 'restricted', work: { text: 'restricted', media: 'success', comments: 'success' } }),
  };

  const commentOrder = (sort: 'hot' | 'latest'): Comment[] => {
    const time = (item: Comment): number => item.publishedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(item.publishedAt);
    const likes = (item: Comment): number => item.likeCount === null ? Number.NEGATIVE_INFINITY : item.likeCount;
    return [...rootComments].sort((a, b) => {
      if (Boolean(a.isPinned) !== Boolean(b.isPinned)) return a.isPinned ? -1 : 1;
      if (sort === 'hot' && likes(a) !== likes(b)) return likes(b) - likes(a);
      if (time(a) !== time(b)) return time(b) - time(a);
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  };
  const orderedComments = { hot: commentOrder('hot'), latest: commentOrder('latest') };

  // 回复夹具：首个一级评论 25 条，覆盖页码 10/10/5、嵌套目标、UP 作者、
  // 缺时间兜底与 7 行折叠边界；其余根评论返回成功空集。
  const replyRoot = rootComments[0]!;
  const replyLong = Array.from({ length: 7 }, (_value, line) =>
    `第七行边界 ${line + 1}：这是一段足够长的回复正文，用于验证实际超过六行才折叠。`).join('\n');
  const replySecondId = '90071992547401102';
  const mockReplies: Reply[] = Array.from({ length: 25 }, (_value, index) => ({
    id: `900719925474011${String(1 + index).padStart(2, '0')}`,
    author: index % 4 === 0 ? first : third,
    publishedAt: index === 4 ? null : new Date(Date.UTC(2026, 2, 1, 3, 3, 4) + index * 60_000).toISOString(),
    text: index === 1 ? replyLong
      : index === 2 ? '回复 @纸飞机: 来源前缀由界面剥离，不重复。'
      : `回复内容 ${index + 1}\n第二行：换行与 emoji 🙂`,
    likeCount: index % 6 === 0 ? null : index,
    replyTo: index === 2 ? first : null,
    parentId: index === 2 ? replySecondId : null,
  }));

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
  // 夹具索引 → 图片组；数量只作夹具，用于覆盖纯图/单图/4/9/12/长图与异常状态。
  const imageSets: Readonly<Record<number, readonly DynamicImage[]>> = {
    0: group('archive-quad', 4),
    1: group('archive-single', 1),
    2: group('archive-nine', 9),
    3: group('archive-many', 12),
    5: mixedGroup('archive-mixed'),
    6: [longImage('archive')],
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
    commentCount: index === 0 ? 45 : index === 1 ? null : index === 5 ? 0 : index,
    images: imageSets[index] ?? [],
    archive: commentArchiveFacets[index],
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
    async readComments({ dynamicId, sort, cursor, signal }) {
      if (signal.aborted) return cancelled;
      const ordered = dynamicId === dynamics[0]!.id ? orderedComments[sort] : [];
      const prefix = `mock-comments:${dynamicId}:${sort}:`;
      const offset = cursor == null ? 0 : cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : Number.NaN;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > ordered.length) {
        return { status: 'error', reason: 'invalid-cursor' };
      }
      return {
        status: 'success',
        data: {
          items: ordered.slice(offset, offset + 20),
          nextCursor: offset + 20 < ordered.length ? `${prefix}${offset + 20}` : null,
        },
      };
    },
    async locateComment({ dynamicId, rootId, sort, signal }) {
      if (signal.aborted) return cancelled;
      const ordered = dynamicId === dynamics[0]!.id ? orderedComments[sort] : [];
      const index = ordered.findIndex(item => item.id === rootId);
      if (index < 0) return { status: 'not-found' };
      const prefix = `mock-comments:${dynamicId}:${sort}:`;
      return {
        status: 'success',
        data: {
          items: ordered.slice(index, index + 20),
          nextCursor: index + 20 < ordered.length ? `${prefix}${index + 20}` : null,
        },
      };
    },
    async readReplies({ dynamicId, rootId, limit, page, cursor, signal }) {
      if (signal.aborted) return cancelled;
      if (!(cursor == null || typeof cursor === 'string')) return failed;
      // 只有第一条动态的首个一级评论带回复夹具；其余根评论返回成功空集。
      const isFirst = dynamicId === dynamics[0]!.id && rootId === replyRoot.id;
      if (page !== undefined) {
        if (!Number.isSafeInteger(page) || page < 1 || limit !== replyAppendSize || cursor != null) return failed;
        if (!isFirst) return { status: 'error' };
        const offset = (page - 1) * replyAppendSize;
        return { status: 'success', data: {
          items: mockReplies.slice(offset, offset + replyAppendSize), nextCursor: null,
          count: mockReplies.length, root: replyRoot, sourceReplyCount: replyRoot.replyCount,
          localReplyCount: mockReplies.length, repliesLastAttempt: 'success',
        } };
      }
      if (limit !== (cursor == null ? replyPreviewSize : replyAppendSize)) return failed;
      if (!isFirst) return { status: 'success', data: { items: [], nextCursor: null } };
      const prefix = `mock-replies:${dynamicId}:${rootId}:`;
      const offset = cursor == null ? 0 : cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : Number.NaN;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > mockReplies.length) {
        return { status: 'error', reason: 'invalid-cursor' };
      }
      return { status: 'success', data: {
        items: mockReplies.slice(offset, offset + limit),
        nextCursor: offset + limit < mockReplies.length ? `${prefix}${offset + limit}` : null,
        sourceReplyCount: replyRoot.replyCount ?? undefined,
      } };
    },
    async locateReply({ dynamicId, rootId, replyId, signal }) {
      if (signal.aborted) return cancelled;
      // 与生产定位一致：只有带回复夹具的第一条动态首个根评论可定位，其余按不存在处理。
      if (dynamicId !== dynamics[0]!.id || rootId !== replyRoot.id) return { status: 'not-found' };
      const index = mockReplies.findIndex(item => item.id === replyId);
      if (index < 0) return { status: 'not-found' };
      const page = Math.floor(index / replyAppendSize) + 1;
      const offset = (page - 1) * replyAppendSize;
      return { status: 'success', data: {
        items: mockReplies.slice(offset, offset + replyAppendSize), nextCursor: null, page,
        count: mockReplies.length, root: replyRoot, sourceReplyCount: replyRoot.replyCount,
        localReplyCount: mockReplies.length, repliesLastAttempt: 'success',
      } };
    },
  };
}
