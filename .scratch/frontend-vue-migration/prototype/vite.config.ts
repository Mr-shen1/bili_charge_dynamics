import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// 只在本原型内代理受控图片夹具；不连接真实 API、OSS 或上游采集。
const imageServer = `http://127.0.0.1:${process.env.IMAGE_SERVER_PORT ?? 4319}`;
const proxy = { '/images': imageServer, '/__': imageServer };

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { proxy },
  preview: { proxy },
  test: { environment: 'jsdom', include: ['tests/unit/**/*.test.ts'] },
});
