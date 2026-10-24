import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import 'element-plus/es/components/base/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/image/style/css';
import 'element-plus/es/components/image-viewer/style/css';
import App from './App.vue';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/DemoPage.vue') },
    { path: '/other', component: () => import('./pages/OtherPage.vue') },
  ],
  // 关闭 Vue Router 自带滚动处理：位置恢复只由预览协调器负责，避免双重恢复竞争。
  scrollBehavior: () => false,
});

// 预览关闭后的位置由协调器显式恢复；浏览器异步滚动恢复会与之竞争。
history.scrollRestoration = 'manual';

createApp(App).use(router).mount('#app');
