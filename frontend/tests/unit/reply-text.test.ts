import { expect, it } from 'vitest';
import { replyBodyText, replyTargetNickname } from '../../src/dynamics/replyText';

it('剥离来源自带的回复目标前缀，界面自己表达目标', () => {
  expect(replyBodyText('回复 @阿蓝: 确实如此')).toBe('确实如此');
  expect(replyBodyText('回复 @阿蓝：全角冒号')).toBe('全角冒号');
  expect(replyBodyText('回复@没有空格: 也可以')).toBe('也可以');
});

it('不是开头前缀或没有目标时原样保留文本', () => {
  expect(replyBodyText('我回复 @阿蓝: 这是引用')).toBe('我回复 @阿蓝: 这是引用');
  expect(replyBodyText('回复 阿蓝: 缺 @')).toBe('回复 阿蓝: 缺 @');
  expect(replyBodyText('')).toBe('');
  expect(replyBodyText('回复 @阿蓝: 后面没有内容')).toBe('后面没有内容');
});

it('只有嵌套回复且目标昵称可用时才表达目标', () => {
  const target = { nickname: '阿蓝' };
  expect(replyTargetNickname({ parentId: '9099', replyTo: target }, '5001')).toBe('阿蓝');
  // 直接回根（父级为空或就是根评论）不重复目标。
  expect(replyTargetNickname({ parentId: null, replyTo: target }, '5001')).toBeNull();
  expect(replyTargetNickname({ parentId: '5001', replyTo: target }, '5001')).toBeNull();
  // 目标昵称缺失不伪造。
  expect(replyTargetNickname({ parentId: '9099', replyTo: null }, '5001')).toBeNull();
  expect(replyTargetNickname({ parentId: '9099', replyTo: { nickname: null } }, '5001')).toBeNull();
});
