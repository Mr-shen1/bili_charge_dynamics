import { describe, expect, it } from 'vitest';
import {
  appHistoryState, entryStateKey, previewStateKey, readEntryMarker, readPreviewMarker,
  type EntryMarker, type PreviewMarker,
} from '../../src/app/historyState';

const entry: EntryMarker = { sessionId: 's-1', pageEntryId: 'e-1' };
const preview: PreviewMarker = { sessionId: 's-1', previewId: 'p-1', groupId: 'many', index: 2 };

describe('历史元数据读取', () => {
  it('没有应用键时既不认为存在也不返回标记', () => {
    expect(readPreviewMarker({ current: '/', position: 3 })).toEqual({ present: false, marker: null });
    expect(readPreviewMarker(undefined)).toEqual({ present: false, marker: null });
    expect(readPreviewMarker('x')).toEqual({ present: false, marker: null });
    expect(readEntryMarker({ current: '/', position: 3 })).toEqual({ present: false, marker: null });
  });

  it('清理标记 null 不触发再次清理', () => {
    expect(readPreviewMarker({ [previewStateKey]: null })).toEqual({ present: false, marker: null });
    expect(readEntryMarker({ [entryStateKey]: null })).toEqual({ present: false, marker: null });
  });

  it('形状完整时返回标记', () => {
    expect(readPreviewMarker({ [previewStateKey]: preview })).toEqual({ present: true, marker: preview });
    expect(readEntryMarker({ [entryStateKey]: entry })).toEqual({ present: true, marker: entry });
  });

  it.each([
    ['非对象', 42],
    ['缺少 previewId', { sessionId: 's-1', groupId: 'many', index: 0 }],
    ['索引为负', { ...preview, index: -1 }],
    ['索引不是整数', { ...preview, index: 1.5 }],
    ['索引是字符串', { ...preview, index: '2' }],
  ])('预览标记 %s 视为损坏标记，需要清理', (_label, value) => {
    expect(readPreviewMarker({ [previewStateKey]: value })).toEqual({ present: true, marker: null });
  });

  it.each([
    ['非对象', 42],
    ['缺少访问标识', { sessionId: 's-1' }],
    ['会话不是字符串', { sessionId: 1, pageEntryId: 'e-1' }],
  ])('访问标记 %s 视为损坏标记，需要补写', (_label, value) => {
    expect(readEntryMarker({ [entryStateKey]: value })).toEqual({ present: true, marker: null });
  });
});

describe('历史元数据写入', () => {
  it('两个应用命名空间一起写入，不复制 Vue Router 自有字段', () => {
    expect(appHistoryState({ entry, preview })).toEqual({
      [entryStateKey]: entry,
      [previewStateKey]: preview,
    });
    expect(appHistoryState({ entry: null, preview: null })).toEqual({
      [entryStateKey]: null,
      [previewStateKey]: null,
    });
  });

  it('写入预览时仍保留访问标识，避免同地址预览覆盖页面访问', () => {
    const state = appHistoryState({ entry, preview: null }) as unknown as Record<string, unknown>;
    expect(state[entryStateKey]).toEqual(entry);
    expect(state[previewStateKey]).toBeNull();
  });

  it('标记只含可序列化的原始值', () => {
    const restored = JSON.parse(JSON.stringify({ entry, preview })) as unknown;
    expect(restored).toEqual({ entry, preview });
    expect(Object.values(entry).every(value => typeof value === 'string')).toBe(true);
    expect(Object.values(preview).every(value => ['string', 'number'].includes(typeof value))).toBe(true);
  });
});
