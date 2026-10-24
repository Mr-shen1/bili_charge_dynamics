import type { DynamicImage, ImageOwner } from '../data/contracts';
import { unavailablePlaceholderUrl } from './assets';
import type { ImageGroup, ImageStatus, PreviewImage } from './types';

/**
 * 归档读取结果到预览组契约的连接层：只使用读取层已经公开的地址与逐图状态，
 * 不反查来源地址、不推断上传结果。组 ID 由 owner 与内容 ID 组成，
 * 保证动态与评论、不同内容之间互不串位，并可直接作为稳定 DOM 标识。
 */
export function previewGroup(owner: ImageOwner, images: readonly DynamicImage[]): ImageGroup {
  return {
    id: `${owner.type}-${owner.id}`,
    label: owner.type === 'dynamic' ? '动态图片' : '评论图片',
    owner: owner.type,
    images: images.map(previewImage),
  };
}

function previewImage(image: DynamicImage): PreviewImage {
  return {
    id: image.id,
    thumbnailUrl: image.thumbnailUrl,
    previewUrl: image.previewUrl ?? unavailablePlaceholderUrl,
    status: statusOf(image),
  };
}

/**
 * pending/failed 是上传状态，没有公开地址；成功状态却没有可用地址说明归档地址无效，
 * 与浏览器加载失败（仍为 ready，由预览错误态局部重试）区分。
 */
function statusOf(image: DynamicImage): ImageStatus {
  if (image.archiveStatus === 'pending') return 'pending';
  if (image.archiveStatus === 'failed') return 'failed';
  // 生产成功状态总是同时给出缩略与预览地址；缺任一个都不把它伪装成可加载图片。
  return image.thumbnailUrl && image.previewUrl ? 'ready' : 'invalid';
}
