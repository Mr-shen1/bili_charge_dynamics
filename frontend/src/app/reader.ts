import { createArchiveReader } from '../data/archiveReader';
import type { DynamicReader } from '../data/contracts';
import { createMockArchiveReader } from '../mock/archiveReader';
import { createFaultReader } from '../mock/faultReader';
import { appMode } from './assembly';

/**
 * 默认真实 API；mock/fault 只在显式 mode 下换成受控读取。
 * 这里必须直接比较 `appMode`（构建期字面量），普通构建才能摇掉 mock/fault 数据与故障计划。
 */
export function createSessionReader(): DynamicReader {
  if (appMode === 'mock') return createMockArchiveReader();
  if (appMode === 'fault') return createFaultReader(createMockArchiveReader());
  return createArchiveReader();
}
