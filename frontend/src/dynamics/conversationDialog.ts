import { inject, provide, reactive, type InjectionKey } from 'vue';

/**
 * 桌面「查看对话」弹窗的开关状态：在应用根部创建，随应用存活，由组件通过
 * provide/inject 取用（与导航协调器、图片预览同一套做法，测试可各建独立实例）。
 * 弹窗内容不写进地址：它只服务当场点开，刷新或分享回到的是原来的详情页。
 */
export interface ConversationDialogTarget {
  readonly dynamicId: string;
  readonly rootId: string;
  readonly replyId: string;
}

export interface ConversationDialogState extends ConversationDialogTarget {
  readonly open: boolean;
}

export interface ConversationDialog {
  readonly state: Readonly<ConversationDialogState>;
  /** 打开一段对话；记住触发元素（没有显式给时取当前焦点），关闭时把焦点还回去。 */
  open(target: ConversationDialogTarget, trigger?: HTMLElement | null): void;
  /** 关闭只改状态；焦点归还由宿主在弹窗卸载之后调用（见 ConversationDialog）。 */
  close(): void;
  restoreFocus(): void;
}

const key: InjectionKey<ConversationDialog> = Symbol('conversation-dialog');

export function createConversationDialog(): ConversationDialog {
  const state = reactive({ open: false, dynamicId: '', rootId: '', replyId: '' });
  let returnFocus: HTMLElement | null = null;
  return {
    state: state as ConversationDialogState,
    open(target, trigger = null) {
      // 有的浏览器点击按钮不给焦点：显式传触发元素，关闭时一定能还回去。
      returnFocus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      state.dynamicId = target.dynamicId;
      state.rootId = target.rootId;
      state.replyId = target.replyId;
      state.open = true;
    },
    close() {
      state.open = false;
    },
    restoreFocus() {
      const target = returnFocus;
      returnFocus = null;
      // 关闭后焦点回到「查看对话」，键盘用户不必重新走一遍列表。
      target?.focus?.();
    },
  };
}

export function provideConversationDialog(dialog: ConversationDialog): void {
  provide(key, dialog);
}

export function useConversationDialog(): ConversationDialog {
  const dialog = inject(key, null);
  if (!dialog) throw new Error('useConversationDialog 需要应用根部的 provideConversationDialog');
  return dialog;
}
