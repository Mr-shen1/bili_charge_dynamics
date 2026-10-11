import { reader as normalReader } from '../data/assembly';
import { createControlledReader } from './controlledReader';

// 独立开发装配：首批/第二批列表和每个详情首次失败一次，重试恢复；无公开参数/页面按钮。
const base = {
  ...normalReader,
  creator: { ...normalReader.creator, nickname: '纸飞机'.repeat(35) },
};
export const reader = createControlledReader(base, {
  list: [
    { delayMs: 200, result: { status: 'error' } }, { delayMs: 200 },
    { delayMs: 200, result: { status: 'error' } }, { delayMs: 200 },
  ],
  eachDetail: [{ delayMs: 200, result: { status: 'error' } }],
  // 讨论追加留出确定性离开窗口；正常静态产物不包含这些计划。
  comments: { '90071992547409931': { hot: [{}, { delayMs: 1500 }] } },
  replies: { '90071992547409931': { 'comment-44': [{}, { delayMs: 1500 }] } },
});
