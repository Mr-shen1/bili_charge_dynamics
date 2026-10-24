import { render } from '@testing-library/vue';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ListPage from '../../src/pages/ListPage.vue';
import DetailPage from '../../src/pages/DetailPage.vue';
import CommentThreadPage from '../../src/pages/CommentThreadPage.vue';
import NotFoundPage from '../../src/pages/NotFoundPage.vue';
import { createSessionPlugin, type AppSession } from '../../src/app/session';
import { createArchiveNavigation, provideArchiveNavigation } from '../../src/app/navigation';
import type { ImagePreviewCoordinator } from '../../src/preview/useImagePreview';
import { PreviewProbe, providePreview } from './preview';

/** 页面行为测试共用的应用壳：唯一导航协调器 + 会话 + 预览探针。 */
function createRouterHost(exposePreview: (preview: ImagePreviewCoordinator) => void) {
  return defineComponent({
    setup() {
      const navigation = createArchiveNavigation();
      provideArchiveNavigation(navigation);
      exposePreview(providePreview(navigation));
      return () => h('div', [h(RouterView), h(PreviewProbe)]);
    },
  });
}

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

export async function showApp(
  reader: AppSession['reader'],
  path = '/',
  /** 需要直接驱动预览协调器（切图/重试）的用例通过它拿到本次挂载的实例。 */
  exposePreview: (preview: ImagePreviewCoordinator) => void = () => undefined,
) {
  const router = archiveRouter();
  await router.push(path);
  await router.isReady();
  render(createRouterHost(exposePreview), {
    global: { plugins: [router, createSessionPlugin({ reader })] },
  });
  return router;
}
