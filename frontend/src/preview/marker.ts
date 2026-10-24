import type { PreviewMarker } from '../app/historyState';

/** 预览标记是否仍属于当前会话且指向现存的组与图片索引。 */
export function validatePreviewMarker(
  marker: PreviewMarker | null,
  sessionId: string,
  resolveGroupSize: (groupId: string) => number | undefined,
): PreviewMarker | null {
  if (!marker || marker.sessionId !== sessionId) return null;
  const size = resolveGroupSize(marker.groupId);
  return size !== undefined && marker.index < size ? marker : null;
}
