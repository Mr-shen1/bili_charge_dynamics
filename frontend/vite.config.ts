import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// 开发/预览只代理受控图片夹具与真实 API；生产由 Nginx 托管静态产物并代理 /api。
const imageServer = `http://127.0.0.1:${process.env.IMAGE_SERVER_PORT ?? 4319}`;
const apiServer = process.env.API_SERVER ?? 'http://127.0.0.1:8000';
// 只代理夹具服务器真正提供的两个观测端点；'/__preview-*' 是应用内的 mock 路由，不能被代理。
const proxy = {
  '/images': imageServer,
  '/__requests': imageServer,
  '/__reset': imageServer,
  '/api': apiServer,
};

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // mock/fault 只由显式 mode 启用；普通 build 不含自检路由与夹具。
  server: { proxy },
  preview: { proxy },
  // 导航/恢复类用例串起多次路由切换与布局帧，在并行跑满时单例耗时可能超过默认 5s；
  // 这里只放宽单例上限，不改变任何行为断言。
  test: { environment: 'jsdom', include: ['tests/unit/**/*.test.ts'], testTimeout: 15_000 },
});
