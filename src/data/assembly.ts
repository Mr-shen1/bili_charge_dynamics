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

export const reader = createMockReader({
  creator,
  dynamics: Array.from({ length: 25 }, (_, index) => ({
    id: `900719925474099${String(31 + index).padStart(2, '0')}`,
    author: index === 2 ? { ...creator, nickname: '长昵称'.repeat(30) } : creator,
    publishedAt: new Date(Date.UTC(2026, 2, 1, 2, 3, 4) - index * 86400000).toISOString(),
    text: index === 0 || index === 10 ? openingText
      : index === 2 ? `长词 ${'a'.repeat(220)} 🙂`
      : `文字日记 ${index + 1}\n把平凡的日子写成一段简单的记录。`,
    // 01 尚无评论数据；正常模拟总数为 0，不伪造已有讨论。
    commentCount: 0,
  })),
});
