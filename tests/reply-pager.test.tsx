import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ReplyPager, replyPageEntries } from '../src/dynamics/ReplyPager';
import styles from '../src/dynamics/Dynamics.module.css';
import { readFileSync } from 'node:fs';

// 将真实样式映射到 Vitest 的 CSS Modules 类名，验证颜色级联而不复制样式规则。
const pagerStyle = ['replyPager', 'pagerPage', 'pagerAction', 'pagerTotal', 'pagerGap']
  .reduce((css, name) => css.replaceAll(`.${name}`, `.${styles[name]}`),
    readFileSync('src/dynamics/Dynamics.module.css', 'utf8'));

it.each([
  { page: 1, pages: 9, expected: [1, 2, 3, 4, 5, '…', 9] },
  { page: 5, pages: 9, expected: [1, '…', 3, 4, 5, 6, 7, '…', 9] },
  { page: 5, pages: 32, expected: [1, '…', 3, 4, 5, 6, 7, '…', 32] },
  { page: 6, pages: 32, expected: [1, '…', 4, 5, 6, 7, 8, '…', 32] },
  { page: 9, pages: 9, expected: [1, '…', 5, 6, 7, 8, 9] },
])('第$page页（共$pages页）按当前页居中显示窗口', ({ page, pages, expected }) => {
  expect(replyPageEntries(page, pages)).toEqual(expected);
});

it('第5页与图三一致，上一页可以返回第4页，第1页不显示上一页', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const props = { pages: 9, busy: false, onSelect, onCollapse: vi.fn() };
  const view = render(<ReplyPager {...props} page={5} />);
  const pager = screen.getByRole('navigation', { name: '回复分页' });
  expect(pager).toHaveTextContent('共9页上一页1…34567…9下一页收起');
  expect(within(pager).getByRole('button', { name: '5' })).toHaveAttribute('aria-current', 'page');
  await user.click(within(pager).getByRole('button', { name: '上一页' }));
  expect(onSelect).toHaveBeenLastCalledWith(4);
  view.rerender(<ReplyPager {...props} page={1} />);
  expect(within(pager).queryByRole('button', { name: '上一页' })).not.toBeInTheDocument();
});

it('读取中禁用上一页，收起仍可操作', () => {
  render(<ReplyPager page={5} pages={9} busy onSelect={vi.fn()} onCollapse={vi.fn()} />);
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '收起' })).toBeEnabled();
});

it.each([
  { page: 1, busy: false }, { page: 1, busy: true },
  { page: 5, busy: false }, { page: 5, busy: true },
])('按图一文字标注，当前页蓝色、其他页码黑色（第$page页，读取中：$busy）', ({ page, busy }) => {
  render(<><style>{pagerStyle}</style><ReplyPager page={page} pages={9} busy={busy}
    onSelect={vi.fn()} onCollapse={vi.fn()} /></>);
  expect(screen.getByRole('button', { name: String(page) })).toHaveStyle({ color: '#00aeec' });
  for (const button of screen.getAllByRole('button').filter(button => /^\d+$/.test(button.textContent ?? ''))) {
    if (button.textContent !== String(page)) expect(button).toHaveStyle({ color: '#18191c' });
  }
});
