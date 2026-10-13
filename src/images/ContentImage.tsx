import { useId, useState } from 'react';
import type { DynamicImage } from '../data/contracts';
import styles from './Images.module.css';

const unknownImageRatio = 4 / 3;

export function ContentImage({ image, preview = false, label, onPreview, onDimensions, reserveRatio = false }: {
  image: DynamicImage; preview?: boolean; label: string; reserveRatio?: boolean; onPreview?(trigger: HTMLElement): void;
  onDimensions?(width: number, height: number): void;
}) {
  const triggerId = useId();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // 未知尺寸的外框在本次展示中保持稳定；实际比例只更新框内图片，避免迟到加载移动阅读锚点。
  const [reservedRatio] = useState(image.width && image.height ? image.width / image.height : unknownImageRatio);
  const [ratio, setRatio] = useState(reservedRatio);
  const source = preview ? image.previewUrl : image.thumbnailUrl;
  const unavailableMessage = image.archiveStatus === 'pending' ? '图片待归档'
    : image.archiveStatus === 'failed' ? '图片归档失败' : '归档图片地址不可用';
  const content = !source ? <span className={styles.error}>{unavailableMessage}</span>
    : failed ? <span className={styles.error}>图片加载失败</span> : <img key={attempt}
    src={source} alt={label} loading={preview ? 'eager' : 'lazy'} style={reserveRatio ? { aspectRatio: ratio } : undefined}
    width={image.width ?? undefined} height={image.height ?? undefined} onError={() => setFailed(true)} onLoad={event => {
      setLoaded(true);
      const { naturalWidth, naturalHeight } = event.currentTarget;
      if (naturalWidth > 0 && naturalHeight > 0) onDimensions?.(naturalWidth, naturalHeight);
      if ((!image.width || !image.height) && naturalWidth > 0 && naturalHeight > 0) setRatio(naturalWidth / naturalHeight);
    }} />;
  return <div className={styles.media} style={reserveRatio ? { aspectRatio: reservedRatio, maxWidth: 360 * reservedRatio, height: 'auto' } : undefined}>
    {onPreview ? <button id={triggerId} type="button" className={styles.thumbnail} aria-label={`预览${label}`}
      onClick={event => onPreview(event.currentTarget)}>{content}</button> : content}
    {source && !failed && !loaded && <span className={styles.loading}>图片加载中</span>}
    {failed && <button type="button" className={styles.retry} aria-label={`重试${label}`}
      onClick={() => { setAttempt(previous => previous + 1); setFailed(false); setLoaded(false); }}>重试</button>}
  </div>;
}
