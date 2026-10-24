import { createApp } from 'vue';
import 'element-plus/es/components/base/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/image/style/css';
import 'element-plus/es/components/image-viewer/style/css';
import App from './app/App.vue';
import { createAppRouter } from './app/router';
import { createSessionReader } from './app/reader';
import { createSessionPlugin } from './app/session';
import './theme/theme.css';

// 位置恢复统一由应用导航协调器显式执行；浏览器异步滚动恢复会与之竞争。
history.scrollRestoration = 'manual';

const app = createApp(App);
app.use(createAppRouter());
// 默认真实 API：会话在根部创建，页面与测试都只通过注入取得读取契约。
app.use(createSessionPlugin({ reader: createSessionReader() }));
app.mount('#app');
