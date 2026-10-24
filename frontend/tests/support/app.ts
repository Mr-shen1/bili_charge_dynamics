import { render } from '@testing-library/vue';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ListPage from '../../src/pages/ListPage.vue';
import DetailPage from '../../src/pages/DetailPage.vue';
import CommentThreadPage from '../../src/pages/CommentThreadPage.vue';
import NotFoundPage from '../../src/pages/NotFoundPage.vue';
import { createSessionPlugin, type AppSession } from '../../src/app/session';
import { createArchiveNavigation, provideArchiveNavigation } from '../../src/app/navigation';
import { PreviewProbe, providePreview } from './preview';

/** 页面行为测试共用的应用壳：唯一导航协调器 + 会话 + 预览探针。 */
const RouterHost = defineComponent({
  setup() {
    const navigation = createArchiveNavigation();
    provideArchiveNavigation(navigation);
    providePreview(navigation);
    return () => h('div', [h(RouterView), h(PreviewProbe)]);
  },
});

export function archiveRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'list', component: ListPage },
      { path: '/ups/:upId', name: 'up-list', component: ListPage, props: true },
      { path: '/dynamics/:dynamicId', name: 'detail', component: DetailPage, props: true },
      {
        path: '/dynamics/:dynamicId/comments/:rootId', name: 'thread',
        component: CommentThreadPage, props: true,
      },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundPage },
    ],
  });
}

export async function showApp(reader: AppSession['reader'], path = '/') {
  const router = archiveRouter();
  await router.push(path);
  await router.isReady();
  render(RouterHost, { global: { plugins: [router, createSessionPlugin({ reader })] } });
  return router;
}
