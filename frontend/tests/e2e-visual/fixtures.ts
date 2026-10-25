// 票据 14 视觉基准的受控归档资料：只通过 page.route 提供生产 Adapter 所需的 DTO，
// 不进入 mock/fault 装配，也不改变任何业务数据。图片地址由本目录的 screenshot 路由替身返回。
// 每个场景都固定内容与时间，截图条件因此可复核。

export const IMAGE_ORIGIN = 'https://images.visual.test';

export const upA = { id: '1001', nickname: '青柠汽水', avatar_url: null };
export const upB = { id: '1002', nickname: '夜航岛', avatar_url: null };

/** 10 个身份足够让 UP 选择条在 1280 宽度也需要自身横向滚动。 */
export const identities = [
  upA,
  upB,
  ...Array.from({ length: 8 }, (_value, index) => ({
    id: String(1003 + index),
    nickname: `虚构监控作者 ${index + 1}`,
    avatar_url: null,
  })),
];

// 不能先转 Number：9007199254741001 已超过安全整数范围，会丢精度并产生重复 ID。
export const dynamicIds = Array.from({ length: 15 }, (_value, index) => `900719925474100${String(index).padStart(2, '0')}`);
export const mainDynamicId = dynamicIds[0]!;
export const emptyCommentsDynamicId = dynamicIds[1]!;
export const restrictedDynamicId = dynamicIds[2]!;
export const pendingCommentsDynamicId = dynamicIds[9]!;

export const commentIds = Array.from({ length: 20 }, (_value, index) => `900719925474020${String(index + 1).padStart(2, '0')}`);
export const rootWithReplies = commentIds[0]!;
export const rootWithoutReplies = commentIds[1]!;

const at = (hour: number, minute: number, day = 1): string =>
  `2026-03-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:04+08:00`;

/** 一行一句，行数即换行数：用于确定性验证 6 行折叠与全文例外。 */
export function lines(count: number, prefix: string): string {
  return Array.from({ length: count }, (_value, index) => `${prefix}第 ${index + 1} 行：受控正文用于视觉与折叠检查。`).join('\n');
}

/** 每行都短到 360px 下不换行，行数才等于视觉行数。 */
export function shortLines(count: number): string {
  return Array.from({ length: count }, (_value, index) => `边界第${index + 1}行`).join('\n');
}

export const longText = lines(9, '长正文');
export const sixLineText = shortLines(6);

function image(dynamicId: string, index: number, kind: 'ok' | 'pending' | 'failed' | 'broken' | 'long' | 'no-url') {
  const id = `image-${dynamicId}-${index}`;
  if (kind === 'pending' || kind === 'failed') {
    return { id, owner: { type: 'dynamic', id: dynamicId }, status: kind, public_url: null, width: null, height: null };
  }
  if (kind === 'no-url') {
    return { id, owner: { type: 'dynamic', id: dynamicId }, status: 'success', public_url: null, width: null, height: null };
  }
  const path = kind === 'long' ? `long-${index}` : kind === 'broken' ? `broken-${index}` : `ok-${dynamicId}-${index}`;
  return {
    id,
    owner: { type: 'dynamic', id: dynamicId },
    status: 'success',
    public_url: `${IMAGE_ORIGIN}/${path}.svg`,
    width: 1200,
    height: kind === 'long' ? 6000 : 675,
  };
}

const sourceUrl = (index: number) => `https://bilibili.test/dynamic/${index}`;

function archive(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    author: upA,
    published_at: at(10, 3),
    edited_at: null,
    edit_status: 'observed',
    text: '',
    content_state: 'success',
    last_attempt: 'success',
    source_comment_count: 0,
    local_comment_count: 0,
    media_sources: [],
    comment_locator: null,
    observed_version: null,
    synced_version: null,
    work: { text: 'success', media: 'success', comments: 'success' },
    media: [],
    ...overrides,
  };
}

/** 列表首批 10 条：长正文、纯图、混合图片状态、恰好 6 行、受限正文各一条。 */
export const firstPage = [
  archive(mainDynamicId, {
    text: longText,
    published_at: at(23, 59),
    source_comment_count: 45,
    local_comment_count: 45,
    root_comments_last_attempt: 'success',
    media_sources: [{ url: sourceUrl(1), width: 1200, height: 675 }],
    media: [0, 1, 2, 3].map(index => image(mainDynamicId, index, 'ok')),
  }),
  archive(emptyCommentsDynamicId, {
    text: '纯图动态：正文为空，图片完整展示。',
    published_at: at(22, 15),
    author: upB,
    source_comment_count: 0,
    root_comments_last_attempt: 'success',
    media: [image(emptyCommentsDynamicId, 0, 'ok')],
  }),
  archive(restrictedDynamicId, {
    text: '',
    published_at: at(21, 40),
    content_state: 'restricted',
    last_attempt: 'restricted',
    work: { text: 'restricted', media: 'success', comments: 'success' },
    source_comment_count: null,
  }),
  archive(dynamicIds[3]!, {
    text: '混合图片状态：成功、待归档、归档失败、无公开地址、加载失败与长图。',
    published_at: at(20, 10),
    media_sources: [{ url: sourceUrl(4), width: 1200, height: 675 }],
    media: [
      image(dynamicIds[3]!, 0, 'ok'),
      image(dynamicIds[3]!, 1, 'pending'),
      image(dynamicIds[3]!, 2, 'failed'),
      image(dynamicIds[3]!, 3, 'no-url'),
      image(dynamicIds[3]!, 4, 'broken'),
      image(dynamicIds[3]!, 5, 'long'),
    ],
  }),
  archive(dynamicIds[4]!, { text: sixLineText, published_at: at(18, 5) }),
  archive(dynamicIds[5]!, {
    text: `长地址 https://example.test/${'a'.repeat(180)} 结束`,
    published_at: at(16, 30),
  }),
  archive(dynamicIds[6]!, { text: '短正文，无图片。', published_at: at(15, 10) }),
  archive(dynamicIds[7]!, {
    text: '两图动态：图片组按两列展示。',
    published_at: at(13, 0),
    author: upB,
    media: [0, 1].map(index => image(dynamicIds[7]!, index, 'ok')),
  }),
  archive(dynamicIds[8]!, { text: '普通第二页之前的最后一条。', published_at: at(11, 20) }),
  archive(pendingCommentsDynamicId, {
    text: '评论尚未归档的受控动态：来源计数不代表本地已有评论。',
    published_at: at(9, 45),
    source_comment_count: 9,
    root_comments_last_attempt: 'pending',
    work: { text: 'success', media: 'success', comments: 'pending' },
  }),
];

export const secondPage = Array.from({ length: 5 }, (_value, index) =>
  archive(dynamicIds[10 + index]!, {
    text: `第二页受控正文 ${index + 1}`,
    published_at: at(8, 30 - index, 2),
  }));

/** 一级评论：8 行、6 行、置顶 UP、纯图、待归档图片与普通评论。 */
const comment = (index: number, overrides: Record<string, unknown> = {}) => {
  const id = commentIds[index]!;
  return {
    id,
    dynamic_id: mainDynamicId,
    root_id: '0',
    parent_id: '0',
    is_pinned: false,
    author: { id: '9002', nickname: '读者甲', avatar_url: null },
    text: `一级评论 ${index + 1}：受控内容。`,
    published_at: at(8, 30, 2),
    like_count: (index * 7) % 23,
    source_reply_count: 0,
    comment_locator: null,
    media_sources: [],
    ...overrides,
  };
};

export const rootComments = [
  comment(0, {
    id: rootWithReplies,
    is_pinned: true,
    author: upA,
    text: longText,
    like_count: 42,
    source_reply_count: 25,
    media_sources: [0, 1, 2, 3].map(index => ({ url: sourceUrl(index), width: 1200, height: 675 })),
    media: [0, 1, 2, 3].map(index => ({
      id: `comment-image-${index}`,
      owner: { type: 'comment', id: rootWithReplies },
      status: 'success',
      public_url: `${IMAGE_ORIGIN}/comment-${index}.svg`,
      width: 1200,
      height: 675,
    })),
  }),
  comment(1, { id: rootWithoutReplies, text: sixLineText, like_count: 17 }),
  comment(2, { author: { id: null, nickname: null, avatar_url: null }, text: '未知身份评论：昵称与头像缺失时仍展示兜底文案。' }),
  comment(3, {
    text: '',
    media_sources: [{ url: sourceUrl(3), width: 1200, height: 675 }],
    media: [{
      id: `comment-image-pure`,
      owner: { type: 'comment', id: commentIds[3]! },
      status: 'success',
      public_url: `${IMAGE_ORIGIN}/comment-pure.svg`,
      width: 1200,
      height: 675,
    }],
  }),
  comment(4, { text: '来源有图片，但当前关联仍待归档。', media_sources: [{ url: sourceUrl(4), width: 800, height: 600 }] }),
  ...Array.from({ length: 15 }, (_value, index) => comment(5 + index, {
    text: `普通一级评论 ${index + 6}：包含点赞与回复计数。`,
    like_count: index,
    source_reply_count: index % 3,
    published_at: at(7, (50 - index * 3) % 60, 2),
  })),
];

export const replyIds = Array.from({ length: 25 }, (_value, index) => `900719925474030${String(index + 1).padStart(2, '0')}`);

export const replies = replyIds.map((id, index) => ({
  id,
  dynamic_id: mainDynamicId,
  root_id: rootWithReplies,
  parent_id: index === 2 ? replyIds[1]! : rootWithReplies,
  author: index % 3 === 0 ? upA : { id: '9003', nickname: '读者乙', avatar_url: null },
  published_at: index === 6 ? null : at(9, index, 2),
  text: index === 0 ? lines(7, '长回复') : `回复正文 ${index + 1}：受控内容。`,
  like_count: index % 5,
  reply_to: index === 2 ? { id: '9003', nickname: '读者乙', avatar_url: null } : null,
}));
