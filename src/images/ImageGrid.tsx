import type { DynamicImage, ImageOwner } from '../data/contracts';
import styles from './Images.module.css';
import { useAppNavigation } from '../app/Navigation';
import { ContentImage } from './ContentImage';

const listThumbnailLimit = 9;

export function ImageGrid({ owner, images, list }: { owner: ImageOwner; images: readonly DynamicImage[]; list: boolean }) {
  const { openImages } = useAppNavigation();
  const isSingle = images.length === 1;
  const columns = isSingle ? 1 : images.length === 4 ? 2 : 3;
  // 新参考的动态双图是同高比例框；contain继续保留完整长图，不照搬来源裁切。
  const pairRatios = owner.type === 'dynamic' && images.length === 2 ? images.map(image => {
    const ratio = image.width && image.height ? image.width / image.height : 4 / 3;
    return Math.max(3 / 4, Math.min(4 / 3, ratio));
  }) : null;
  const visible = list ? images.slice(0, listThumbnailLimit) : images;
  return <div role="group" aria-label={owner.type === 'comment' ? '评论图片' : '动态图片'} className={`${styles.grid} ${list ? styles.listGrid : ''} ${isSingle ? styles.single : ''} ${pairRatios ? styles.pair : ''}`}
    style={{ gridTemplateColumns: pairRatios ? pairRatios.map(ratio => `minmax(0, ${ratio}fr)`).join(' ') : `repeat(${columns}, minmax(0, 1fr))`,
      maxWidth: pairRatios ? 268 * pairRatios.reduce((sum, ratio) => sum + ratio, 0) + 8 : undefined }}>
    {visible.map((image, index) => <div className={styles.tile} key={image.id} style={pairRatios ? { aspectRatio: pairRatios[index] } : undefined}>
      <ContentImage image={image} reserveRatio={isSingle} label={`图片 ${index + 1}`} onPreview={trigger => openImages(owner, images, index, trigger)} />
      {list && index === listThumbnailLimit - 1 && images.length > listThumbnailLimit
        && <span className={styles.remaining}>+{images.length - listThumbnailLimit}</span>}
    </div>)}
  </div>;
}
