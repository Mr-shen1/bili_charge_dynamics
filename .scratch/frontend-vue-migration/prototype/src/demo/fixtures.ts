export type ImageStatus = 'ready' | 'pending' | 'failed' | 'invalid' | 'broken' | 'flaky';

export interface PreviewImage {
  readonly id: string;
  /** 缩略图地址；pending/failed 没有公开地址。 */
  readonly thumbnailUrl: string | null;
  /** 预览地址；pending/failed 没有公开地址，使用应用自有占位。 */
  readonly previewUrl: string;
  readonly status: ImageStatus;
}

export interface ImageGroup {
  readonly id: string;
  readonly label: string;
  readonly owner: 'dynamic' | 'comment';
  readonly images: readonly PreviewImage[];
}

/** 应用自有占位地址：不是来源业务图，也不请求上游。 */
export const unavailablePlaceholderUrl = '/images/unavailable/placeholder.svg';

function ready(key: string, options: { shared?: boolean } = {}): PreviewImage {
  return {
    id: key,
    status: 'ready',
    thumbnailUrl: options.shared ? `/images/full/${key}.svg` : `/images/thumb/${key}.svg`,
    previewUrl: `/images/full/${key}.svg`,
  };
}

function withStatus(key: string, status: Exclude<ImageStatus, 'ready'>): PreviewImage {
  const thumbnails: Record<Exclude<ImageStatus, 'ready'>, string | null> = {
    pending: null,
    failed: null,
    invalid: `/images/invalid/${key}-thumb.svg`,
    broken: `/images/broken/${key}-thumb.svg`,
    flaky: `/images/thumb/${key}.svg`,
  };
  const previews: Record<Exclude<ImageStatus, 'ready'>, string> = {
    pending: unavailablePlaceholderUrl,
    failed: unavailablePlaceholderUrl,
    invalid: `/images/invalid/${key}.svg`,
    broken: `/images/broken/${key}.svg`,
    flaky: `/images/flaky/${key}.svg?failures=1`,
  };
  return { id: key, status, thumbnailUrl: thumbnails[status], previewUrl: previews[status] };
}

export const imageGroups: readonly ImageGroup[] = [
  { id: 'single', label: '单图', owner: 'dynamic', images: [ready('single-1')] },
  {
    id: 'quad',
    label: '四图',
    owner: 'dynamic',
    images: [ready('quad-1'), ready('quad-2'), ready('quad-3'), ready('quad-4')],
  },
  {
    id: 'many',
    label: '十二图',
    owner: 'dynamic',
    images: Array.from({ length: 12 }, (_value, index) => ready(`many-${index + 1}`)),
  },
  { id: 'long', label: '长图', owner: 'dynamic', images: [ready('long-1')] },
  {
    id: 'mixed',
    label: '成功与异常混合',
    owner: 'comment',
    images: [
      ready('mixed-1'),
      withStatus('mixed-2', 'broken'),
      withStatus('mixed-3', 'pending'),
      withStatus('mixed-4', 'invalid'),
      withStatus('mixed-5', 'flaky'),
    ],
  },
  {
    id: 'shared',
    label: '缩略与预览共用地址',
    owner: 'comment',
    images: [ready('shared-1', { shared: true }), ready('shared-2', { shared: true }), ready('shared-3', { shared: true })],
  },
  { id: 'no-url', label: '未上传组', owner: 'dynamic', images: [withStatus('no-url-1', 'pending'), withStatus('no-url-2', 'failed')] },
  { id: 'comment-a', label: '评论 A', owner: 'comment', images: [ready('comment-a-1'), ready('comment-a-2')] },
  { id: 'comment-b', label: '评论 B', owner: 'comment', images: [ready('comment-b-1'), ready('comment-b-2')] },
];

export function findGroup(groupId: string): ImageGroup | undefined {
  return imageGroups.find(group => group.id === groupId);
}
