import { createMockReader } from './mockReader';

const creator = { id: '90071992547409930', nickname: '纸飞机', avatarUrl: '/creator-avatar.v1.svg' };
const openingText = [
  '今天把小小的想法写在这里。🙂',
  '换一行，继续记录那些值得记住的瞬间。',
  `https://example.test/${'very-long-path-segment-'.repeat(8)}no-special-navigation`,
  '#日常记录# @朋友 都是普通文字，不会跳转。',
  '<script>window.__unsafeTextExecuted = true</script>',
  '<img src=x onerror=alert(1)>',
  '第七行：详情中可以从头到尾阅读完整正文。',
  '第八行：这是一份虚构身份的本地文字动态演示。',
].join('\n');

const longCommentText = [
  '认真阅读后写下自己的想法。🙂',
  '换行后继续讨论，文字保持原样。',
  `https://example.test/comments/${'very-long-path-segment-'.repeat(8)}`,
  '#评论话题# @朋友 都是普通文字，不会跳转。',
  '<script>window.__unsafeTextExecuted = true</script>',
  '<img src=x onerror=alert(1)>',
  '评论内容第七段：可以展开后完整阅读。',
  '评论内容第八段：也可以再次收起。',
].join('\n');

export const reader = createMockReader({
  creator,
  dynamics: Array.from({ length: 25 }, (_, index) => ({
    id: `900719925474099${String(31 + index).padStart(2, '0')}`,
    author: index === 2 ? { ...creator, nickname: '长昵称'.repeat(30) } : creator,
    publishedAt: new Date(Date.UTC(2026, 2, 1, 2, 3, 4) - index * 86400000).toISOString(),
    text: index === 0 || index === 10 ? openingText
      : index === 2 ? `长词 ${'a'.repeat(220)} 🙂`
      : `文字日记 ${index + 1}\n把平凡的日子写成一段简单的记录。`,
    commentCount: index === 0 ? 45 : 0,
  })),
  comments: {
    '90071992547409931': Array.from({ length: 45 }, (_, index) => ({
      id: `comment-${String(index).padStart(2, '0')}`,
      author: index === 44 ? creator : index === 43 ? { ...creator, id: 'same-name-reader' }
        : index === 42 ? { id: 'unknown-reader', nickname: null, avatarUrl: null }
        : { id: `reader-${index}`, nickname: index === 41 ? '长昵称'.repeat(30) : `读者 ${index + 1}`, avatarUrl: null },
      publishedAt: index === 42 ? null : new Date(Date.UTC(2026, 2, 1, 3, 0, 0) - index * 60000).toISOString(),
      text: index === 0 || index === 44 ? `长评论 ${index + 1}\n${longCommentText}`
        : index === 42 ? '' : index === 41 ? `长词 ${'a'.repeat(220)} 🙂`
        : `评论记录 ${index + 1}\n@朋友 谢谢分享 🙂`,
      likeCount: index === 42 ? null : index,
    })),
  },
});
