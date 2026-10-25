/** 读取区域共享的公开状态；与传输无关，避免各组件重复字面联合。 */
export type ReadStatus = 'loading' | 'success' | 'error' | 'cancelled';
/** 精确入口额外区分“目标不存在”：它有自己的提示与返回入口，不交给通用失败提示。 */
export type LocateStatus = ReadStatus | 'not-found';
