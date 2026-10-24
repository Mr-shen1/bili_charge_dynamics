import { describe, expect, it } from 'vitest';
import { createAssembly, resolveAssemblyKind } from '../../src/app/assembly';

describe('装配选择', () => {
  it('普通构建一律是生产装配', () => {
    expect(resolveAssemblyKind('production')).toBe('production');
    expect(resolveAssemblyKind('development')).toBe('production');
    expect(resolveAssemblyKind('anything-else')).toBe('production');
  });

  it('只有显式 mock / fault 才启用独立装配', () => {
    expect(resolveAssemblyKind('mock')).toBe('mock');
    expect(resolveAssemblyKind('fault')).toBe('fault');
  });

  it('自检路由只随 mock/fault 装配注册', () => {
    expect(createAssembly('production')).toEqual({ kind: 'production', previewFixtures: false });
    expect(createAssembly('mock')).toEqual({ kind: 'mock', previewFixtures: true });
    expect(createAssembly('fault')).toEqual({ kind: 'fault', previewFixtures: true });
  });
});
