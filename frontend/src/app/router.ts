import { createRouter, createWebHistory, type Router } from 'vue-router';
import { previewFixturesEnabled } from './assembly';

/**
 * 正式页面路由：六条基线路由（全部/单 UP 列表、动态详情、独立楼中楼、管理列表、单 UP 管理）
 * 加一级评论与楼中楼回复两个精确入口、一段对话的只读会话页；图片自检页只在 mock/fault 装配注册。
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
        // 一级评论精确入口：动态与目标评论身份都在路径里，直接打开、刷新与历史返回走同一页面。
        path: '/dynamics/:dynamicId/comments/:rootId/locate', name: 'comment-locate',
        component: () => import('../pages/DetailPage.vue'), props: true,
      },
      {
        // 楼中楼回复精确入口：宽屏在详情里定位，窄屏在独立楼中楼页定位，共用同一链接。
        path: '/dynamics/:dynamicId/comments/:rootId/replies/:replyId/locate', name: 'reply-locate',
        component: () => import('../pages/ReplyLocatePage.vue'), props: true,
      },
      {
        // 会话列表：一段对话的独立只读页，身份含动态、根评论与入口回复，支持直达与刷新。
        path: '/dynamics/:dynamicId/comments/:rootId/replies/:replyId/conversation', name: 'conversation',
        component: () => import('../pages/ConversationPage.vue'), props: true,
      },
      {
        // 楼中楼页：外层按访问标识重建，同一路径的多次访问各存各的回复访问快照。
        path: '/dynamics/:dynamicId/comments/:rootId', name: 'thread',
        component: () => import('../pages/ThreadPage.vue'), props: true,
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
    // 关闭 Vue Router 自带滚动处理：主动入口、历史返回与预览关闭的位置
    // 统一由应用导航协调器在内容与展开状态还原后决定，路由本身不参与竞争。
    scrollBehavior: () => false,
  });
  return router;
}
