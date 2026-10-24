/** 读取区域共享的公开状态；与传输无关，避免各组件重复字面联合。 */
export type ReadStatus = 'loading' | 'success' | 'error' | 'cancelled';
