// 预览层的图片组契约：与数据来源无关，演示夹具与后续归档读取都实现它。
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
