import { createApp } from 'vue';
import 'element-plus/es/components/base/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/image/style/css';
import 'element-plus/es/components/image-viewer/style/css';
import App from './app/App.vue';
import { createAppRouter } from './app/router';
import './theme/theme.css';

// 预览关闭后的位置由协调器显式恢复；浏览器异步滚动恢复会与之竞争。
history.scrollRestoration = 'manual';

createApp(App).use(createAppRouter()).mount('#app');
