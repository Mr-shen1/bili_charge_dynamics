import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom 无滚动布局；真实顶部定位由 Playwright 验证。
window.scrollTo = vi.fn();

afterEach(cleanup);
