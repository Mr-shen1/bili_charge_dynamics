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

const pictures = Array.from({ length: 12 }, (_, index) => {
  const signatureExample = index === 0 ? '?signature=demo%2Fonly&expires=123' : '';
  return {
    id: `landscape-${index + 1}`,
    thumbnailUrl: `/demo-images/landscape-${index + 1}-thumb.v1.png${signatureExample}`,
    previewUrl: `/demo-images/landscape-${index + 1}-preview.v1.png${signatureExample}`,
    width: index === 11 ? 600 : 1200, height: index === 11 ? 1600 : index === 10 ? 600 : 900,
  };
});

export const reader = createMockReader({
  creator,
  dynamics: Array.from({ length: 25 }, (_, index) => ({
    id: `900719925474099${String(31 + index).padStart(2, '0')}`,
    author: index === 2 ? { ...creator, nickname: '长昵称'.repeat(30) } : creator,
    publishedAt: new Date(Date.UTC(2026, 2, 1, 2, 3, 4) - index * 86400000).toISOString(),
    text: index === 0 || index === 10 ? openingText
      : index === 1 ? ''
      : index === 2 ? `长词 ${'a'.repeat(220)} 🙂`
      : [3, 4, 5, 6, 8].includes(index) ? `图文日记 ${index + 1}\n用自绘风景记录今天。`
      : `文字日记 ${index + 1}\n把平凡的日子写成一段简单的记录。`,
    images: index === 1 ? pictures.slice(0, 1) : index === 3 ? pictures.slice(0, 4)
      : index === 4 ? pictures.slice(0, 9) : index === 5 ? pictures
      : index === 6 ? [{ ...pictures[10]!, width: null, height: null }]
      : index === 8 ? pictures.slice(11) : [],
    commentCount: index === 0 ? 70 : 0,
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
      replyCount: index === 44 ? 25 : 0,
    })),
  },
  replies: {
    '90071992547409931': {
      'comment-44': Array.from({ length: 25 }, (_, index) => ({
        id: `reply-${String(index).padStart(2, '0')}`,
        author: index === 0 ? creator : index === 1 ? { ...creator, id: 'same-name-reader' }
          : index === 2 ? { id: 'unknown-reader', nickname: null, avatarUrl: null }
          : { id: `reply-reader-${index}`, nickname: index === 3 ? '长回复昵称'.repeat(30) : `回复读者 ${index + 1}`, avatarUrl: null },
        publishedAt: new Date(Date.UTC(2026, 2, 1, 4, 0, 0) + index * 60000).toISOString(),
        text: index === 0 ? `长回复 1\n${longCommentText}` : index === 2 ? ''
          : index === 3 ? `回复记录 4\n${'a'.repeat(220)} 🙂` : `回复记录 ${index + 1}\n谢谢分享 🙂`,
        likeCount: index === 2 ? null : index,
        replyTo: index === 2 ? null : index === 3 ? { id: 'long-target', nickname: '长目标昵称'.repeat(30), avatarUrl: null } : creator,
      })),
    },
  },
});
