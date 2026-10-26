import { nextTick, onMounted, onUnmounted } from 'vue';
import { onUserScroll } from '../app/readingPosition';

/**
 * 精确定位的一次性滚动：结果落下后消费一次，不反复抢滚动。
 *
 * - `arm()` 只在显式进入/显式重试时挂起；成功、失败与“不存在”都只落一次点。
 * - `settle()` 在布局稳定（`nextTick`）后滚到目标；目标读不到时退回容器提示，
 *   绝不把楼层或列表顶部当定位结果。
 * - `releaseOnUserScroll` 为真时，用户在结果落下前自己滚动/触摸/按键就不再抢回。
 *
 * 两个精确入口（宽屏内联回复区、窄屏楼中楼页）共用这一处例程；就绪判定与
 * 加载中的跳过仍由调用方按各自状态决定。
 */
export function useLocateTarget(options: {
  readonly target: () => HTMLElement | null | undefined;
  readonly container: () => HTMLElement | null | undefined;
  readonly releaseOnUserScroll?: boolean;
}) {
  let pending = false;
  let release = (): void => undefined;

  onMounted(() => {
    if (!pending || !options.releaseOnUserScroll) return;
    release = onUserScroll(() => {
      pending = false;
      release();
    });
  });
  onUnmounted(() => {
    pending = false;
    release();
  });

  return {
    /** 挂起一次定位（显式重试后目标仍要回到视口）。 */
    arm(): void {
      pending = true;
    },
    async settle(): Promise<void> {
      if (!pending) return;
      await nextTick();
      if (!pending) return;
      pending = false;
      release();
      (options.target() ?? options.container())?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
    },
  };
}
