import type { Dynamic, DynamicReader, ReadResult, User } from '../data/contracts';

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
    images: [],
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
