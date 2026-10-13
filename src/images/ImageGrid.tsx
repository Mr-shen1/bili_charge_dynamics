import type { DynamicImage } from '../data/contracts';
import styles from './Images.module.css';
import { useAppNavigation } from '../app/Navigation';
import { ContentImage } from './ContentImage';
import type { ImageOwner } from './ImagePreview';

const listThumbnailLimit = 9;

export function ImageGrid({ owner, images, list }: { owner: ImageOwner; images: readonly DynamicImage[]; list: boolean }) {
  const { openImages } = useAppNavigation();
  const isSingle = images.length === 1;
  const columns = isSingle ? 1 : images.length === 4 ? 2 : 3;
  const visible = list ? images.slice(0, listThumbnailLimit) : images;
  return <div role="group" aria-label="动态图片" className={`${styles.grid} ${isSingle ? styles.single : ''}`}
    style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
    {visible.map((image, index) => <div className={styles.tile} key={image.id}>
      <ContentImage image={image} reserveRatio={isSingle} label={`图片 ${index + 1}`} onPreview={trigger => openImages(owner, images, index, trigger)} />
      {list && index === listThumbnailLimit - 1 && images.length > listThumbnailLimit
        && <span className={styles.remaining}>+{images.length - listThumbnailLimit}</span>}
    </div>)}
  </div>;
}
