import { createRouter, createWebHistory, type Router } from 'vue-router';
import { previewFixturesEnabled } from './assembly';

/**
 * 六条正式页面路由保持与代码基线一致：全部/单 UP 列表、动态详情、独立楼中楼、管理列表、单 UP 管理。
 * 图片自检页只在 mock/fault 装配注册，生产构建不会得到该入口。
 */
export function createAppRouter(): Router {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'list', component: () => import('../pages/ListPage.vue') },
      { path: '/ups/:upId', name: 'up-list', component: () => import('../pages/ListPage.vue'), props: true },
      { path: '/dynamics/:dynamicId', name: 'detail', component: () => import('../pages/DetailPage.vue'), props: true },
      {
        path: '/dynamics/:dynamicId/comments/:rootId', name: 'thread',
        component: () => import('../pages/CommentThreadPage.vue'), props: true,
      },
      { path: '/manage', name: 'manage', component: () => import('../pages/ManagePage.vue') },
      { path: '/manage/ups/:upId', name: 'manage-up', component: () => import('../pages/ManageUpPage.vue'), props: true },
      ...(previewFixturesEnabled
        ? [
          { path: '/__preview-fixtures', name: 'preview-fixtures', component: () => import('../mock/PreviewFixturesPage.vue') },
          { path: '/__preview-other', name: 'preview-other', component: () => import('../mock/PreviewOtherPage.vue') },
        ]
        : []),
      { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('../pages/NotFoundPage.vue') },
    ],
    // 关闭 Vue Router 自带滚动处理：预览与阅读位置恢复由唯一协调器负责，避免双重恢复。
    scrollBehavior: () => false,
  });
  return router;
}
