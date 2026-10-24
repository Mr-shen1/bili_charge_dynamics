import { onMounted, onUnmounted, shallowRef } from 'vue';
import type { DynamicReader } from '../data/contracts';
import { reportReadError } from '../app/readError';

/**
 * 楼中楼的 UP 身份：只额外读一次动态详情取作者 ID，用于回复与根评论的 UP 标识。
 * 该辅助读取失败、取消或迟到都不阻断回复主读取，也不产生页面级错误提示。
 */
export function useThreadAuthor(reader: DynamicReader, dynamicId: string) {
  const authorId = shallowRef('');
  let request: AbortController | null = null;
  let active = false;

  async function read(): Promise<void> {
    if (!active || request) return;
    const controller = new AbortController();
    request = controller;
    try {
      const result = await reader.readDetail({ id: dynamicId, signal: controller.signal });
      if (!active || request !== controller || controller.signal.aborted) return;
      if (result.status === 'success') authorId.value = result.data.author.id;
    } catch (error) {
      if (active && request === controller && !controller.signal.aborted) {
        reportReadError('楼中楼动态作者', error);
      }
    } finally {
      if (request === controller) request = null;
    }
  }

  onMounted(() => {
    active = true;
    void read();
  });
  onUnmounted(() => {
    active = false;
    request?.abort();
    request = null;
  });

  return { authorId };
}
