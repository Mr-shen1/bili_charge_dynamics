import { describe, expect, it } from 'vitest';
import { validatePreviewMarker } from '../../src/preview/marker';
import type { PreviewMarker } from '../../src/app/historyState';

const preview: PreviewMarker = { sessionId: 's-1', previewId: 'p-1', groupId: 'many', index: 2 };

describe('预览标记有效性', () => {
  it('会话不一致即失效（刷新后旧标记不重开预览）', () => {
    expect(validatePreviewMarker(preview, 'other-session', () => 12)).toBeNull();
  });

  it('组不存在或索引越界即失效', () => {
    expect(validatePreviewMarker(preview, 's-1', () => undefined)).toBeNull();
    expect(validatePreviewMarker(preview, 's-1', () => 2)).toBeNull();
    expect(validatePreviewMarker({ ...preview, index: 11 }, 's-1', () => 12)).toEqual({ ...preview, index: 11 });
  });

  it('没有标记时保持关闭', () => {
    expect(validatePreviewMarker(null, 's-1', () => 12)).toBeNull();
  });
});
