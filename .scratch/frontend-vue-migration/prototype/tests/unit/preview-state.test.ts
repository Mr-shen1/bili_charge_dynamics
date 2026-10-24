import { describe, expect, it } from 'vitest';
import { isRecord, markerState, previewStateKey, readMarker, validateMarker, type PreviewMarker } from '../../src/preview/state';

const marker: PreviewMarker = { sessionId: 's-1', previewId: 'p-1', groupId: 'many', index: 2 };

describe('历史元数据读取', () => {
  it('没有应用键时既不认为存在也不返回标记', () => {
    expect(readMarker({ current: '/', position: 3 })).toEqual({ present: false, marker: null });
    expect(readMarker(undefined)).toEqual({ present: false, marker: null });
    expect(readMarker('x')).toEqual({ present: false, marker: null });
  });

  it('清理标记 null 不触发再次清理', () => {
    expect(readMarker({ [previewStateKey]: null })).toEqual({ present: false, marker: null });
  });

  it('形状完整时返回标记', () => {
    expect(readMarker({ [previewStateKey]: marker })).toEqual({ present: true, marker });
  });

  it.each([
    ['非对象', 42],
    ['缺少 previewId', { sessionId: 's-1', groupId: 'many', index: 0 }],
    ['索引为负', { ...marker, index: -1 }],
    ['索引不是整数', { ...marker, index: 1.5 }],
    ['索引是字符串', { ...marker, index: '2' }],
  ])('%s 视为损坏标记，需要清理', (_label, value) => {
    expect(readMarker({ [previewStateKey]: value })).toEqual({ present: true, marker: null });
  });
});

describe('历史元数据写入', () => {
  it('只写应用命名空间，不复制 Vue Router 自有字段', () => {
    expect(markerState(marker)).toEqual({ [previewStateKey]: marker });
    expect(markerState(null)).toEqual({ [previewStateKey]: null });
  });

  it('标记只含可序列化的原始值', () => {
    const restored = JSON.parse(JSON.stringify(marker)) as unknown;
    expect(restored).toEqual(marker);
    expect(Object.values(marker).every(value => ['string', 'number'].includes(typeof value))).toBe(true);
  });
});

describe('标记有效性', () => {
  it('会话不一致即失效（刷新后旧标记不重开预览）', () => {
    expect(validateMarker(marker, 'other-session', () => 12)).toBeNull();
  });

  it('组不存在或索引越界即失效', () => {
    expect(validateMarker(marker, 's-1', () => undefined)).toBeNull();
    expect(validateMarker(marker, 's-1', () => 2)).toBeNull();
    expect(validateMarker({ ...marker, index: 11 }, 's-1', () => 12)).toEqual({ ...marker, index: 11 });
  });

  it('没有标记时保持关闭', () => {
    expect(validateMarker(null, 's-1', () => 12)).toBeNull();
  });
});

describe('记录判断', () => {
  it('只把普通对象视为记录', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
});
