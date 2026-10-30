import { createApp } from 'vue';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/base/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/collapse/style/css';
import 'element-plus/es/components/collapse-item/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/form-item/style/css';
import 'element-plus/es/components/image/style/css';
import 'element-plus/es/components/image-viewer/style/css';
import 'element-plus/es/components/overlay/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/radio/style/css';
import 'element-plus/es/components/radio-group/style/css';
import 'element-plus/es/components/radio-button/style/css';
import 'element-plus/es/components/tag/style/css';
import App from './app/App.vue';
import { createAppRouter } from './app/router';
import { createSessionReader } from './app/reader';
import { createManagementApi } from './manage/managementApi';
import { createSessionPlugin } from './app/session';
import './theme/theme.css';
import './theme/reading.css';

// 位置恢复统一由应用导航协调器显式执行；浏览器异步滚动恢复会与之竞争。
history.scrollRestoration = 'manual';

const app = createApp(App);
app.use(createAppRouter());
// 默认真实 API：会话在根部创建，页面与测试都只通过注入取得读取契约。
// 管理接口与归档读取一起在根部装配；mock/fault 只替换归档读取，不伪造管理成功。
app.use(createSessionPlugin({ reader: createSessionReader(), management: createManagementApi() }));
app.mount('#app');
