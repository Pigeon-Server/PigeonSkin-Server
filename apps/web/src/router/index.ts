// 路由表。路径语义与原版保持接近（/skinlib、/player、/user、/admin…），
// 但内部全部指向 SPA 视图。需要登录的路由由 beforeEach 守卫统一拦截。
import { createRouter, createWebHistory } from 'vue-router';
import { useSessionStore } from '@/stores/session';
import { integrationModuleForPlugin } from '@/lib/integrations';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/account/security', meta: { requiresAuth: true, title: 'security.title' }, component: () => import('@/views/user/Security.vue') },
    { path: '/account/devices', alias: '/user/devices', meta: { requiresAuth: true, title: 'devices.title' }, component: () => import('@/views/user/Devices.vue') },
    { path: '/auth/two-factor', meta: { layout: 'auth', title: 'security.two_factor' }, component: () => import('@/views/auth/TwoFactor.vue') },
    { path: '/manual/:slug?', meta: { layout: 'manual', title: 'manual.title' }, component: () => import('@/views/Manual.vue') },
    { path: '/', component: () => import('@/views/Home.vue') },
    { path: '/votes', alias: '/user/ps_vote', meta: { requiresAuth: true, title: 'votes.title' }, component: () => import('@/views/user/Votes.vue') },
    { path: '/votes/:id', meta: { requiresAuth: true, title: 'votes.title' }, component: () => import('@/views/user/Vote.vue') },
    { path: '/auth/initialize', meta: { layout: 'auth', requiresAuth: true, title: 'auth.initialize.title' }, component: () => import('@/views/auth/Initialize.vue') },
    { path: '/connect/authorize/:id', meta: { layout: 'auth', requiresAuth: true, title: 'connect.authorize_title' }, component: () => import('@/views/auth/Connect.vue') },
    { path: '/connect/device', meta: { layout: 'auth', requiresAuth: true, title: 'connect.device_title' }, component: () => import('@/views/auth/Connect.vue') },
    {
      path: '/login',
      alias: '/auth/login',
      meta: { layout: 'auth', title: 'auth.login' },
      component: () => import('@/views/auth/Login.vue'),
    },
    {
      path: '/register',
      alias: '/auth/register',
      meta: { layout: 'auth', title: 'auth.register' },
      component: () => import('@/views/auth/Register.vue'),
    },
    {
      path: '/forgot-password',
      alias: '/auth/forgot',
      meta: { layout: 'auth', title: 'auth.forgot_title' },
      component: () => import('@/views/auth/ForgotPassword.vue'),
    },
    {
      path: '/reset-password',
      meta: { layout: 'auth', title: 'auth.reset_title' },
      component: () => import('@/views/auth/ResetPassword.vue'),
    },
    {
      path: '/verify-email',
      meta: { layout: 'auth', title: 'auth.email_verification' },
      component: () => import('@/views/auth/VerifyEmail.vue'),
    },
    {
      path: '/setup',
      meta: { layout: 'auth', title: 'setup.title' },
      component: () => import('@/views/auth/Setup.vue'),
    },

    { path: '/skinlib', meta: { title: 'general.skinlib' }, component: () => import('@/views/skinlib/Index.vue') },
    // 创作者主页（公开）。放在 /user 用户中心之前，:uid 纯数字与 /user/* 静态段不冲突。
    {
      path: '/user/:uid(\\d+)',
      meta: { title: 'user.profile_title' },
      component: () => import('@/views/user/Home.vue'),
    },
    { path: '/editor/:kind', meta: { requiresAuth: true, title: 'editor.title' }, component: () => import('@/views/editor/Editor.vue') },
    { path: '/skinlib/create', meta: { requiresAuth: true, title: 'skinlib.create.title' }, component: () => import('@/views/skinlib/Create.vue') },
    {
      path: '/skinlib/upload',
      meta: { requiresAuth: true, title: 'skinlib.upload.title' },
      component: () => import('@/views/skinlib/Upload.vue'),
    },
    {
      path: '/skinlib/:tid',
      alias: '/skinlib/show/:tid',
      // 该页按纹理可见性自行管理 SEO（Show.vue），App.vue 不再兜底覆写。
      meta: { title: 'general.skinlib', seoSelf: true },
      component: () => import('@/views/skinlib/Show.vue'),
    },

    {
      path: '/player',
      alias: '/user/player',
      meta: { requiresAuth: true },
      component: () => import('@/views/player/Index.vue'),
    },
    {
      path: '/closet',
      alias: '/user/closet',
      meta: { requiresAuth: true },
      component: () => import('@/views/closet/Index.vue'),
    },
    {
      path: '/user',
      meta: { requiresAuth: true },
      component: () => import('@/views/user/Index.vue'),
    },
    {
      path: '/profile',
      alias: ['/user/profile', '/auth/bind', '/.well-known/change-password'],
      meta: { requiresAuth: true },
      component: () => import('@/views/user/Profile.vue'),
    },
    {
      path: '/reports',
      alias: '/user/reports',
      meta: { requiresAuth: true },
      component: () => import('@/views/user/Reports.vue'),
    },
    { path: '/tickets', meta: { requiresAuth: true, title: 'ticket.title' }, component: () => import('@/views/user/Tickets.vue') },
    { path: '/tickets/:id', meta: { requiresAuth: true, title: 'ticket.title' }, component: () => import('@/views/user/Ticket.vue') },

    { path: '/connections', alias: '/user/connections', redirect: '/user/config' },
    { path: '/user/config', meta: { requiresAuth: true, title: 'integration.modules.generator' }, component: () => import('@/views/user/ConfigGenerator.vue') },
    { path: '/user/applications', meta: { requiresAuth: true, title: 'oauth.applications' }, component: () => import('@/views/user/Applications.vue') },
    {
      path: '/admin',
      component: () => import('@/views/admin/Index.vue'),
      children: [
        { path: 'manual', meta: { title: 'manual.manage' }, component: () => import('@/views/admin/Manual.vue') },
        { path: 'votes', meta: { title: 'votes.management' }, component: () => import('@/views/admin/Votes.vue') },
        { path: 'pigeon-api', meta: { title: 'pigeon.title' }, component: () => import('@/views/admin/PigeonApi.vue') },
        { path: 'ps_vote/record', redirect: '/admin/votes' },
        { path: 'plugins/config/pigeon-skin_vote', redirect: '/admin/votes' },
        { path: 'plugins/config/pigeon-skin_api', redirect: '/admin/pigeon-api' },
        { path: 'live2d', meta: { title: 'live2d.title' }, component: () => import('@/views/admin/Live2D.vue') },
        { path: 'integrations/connect', meta: { title: 'connect.clients' }, component: () => import('@/views/admin/Connect.vue') },
        { path: '', component: () => import('@/views/admin/Overview.vue') },
        { path: 'users', component: () => import('@/views/admin/Users.vue') },
        { path: 'players', component: () => import('@/views/admin/Players.vue') },
        { path: 'textures', component: () => import('@/views/admin/Textures.vue') },
        { path: 'comments', component: () => import('@/views/admin/Comments.vue') },
        { path: 'tasks', component: () => import('@/views/admin/BackgroundTasks.vue') },
        { path: 'reports', component: () => import('@/views/admin/Reports.vue') },
        { path: 'tickets', component: () => import('@/views/admin/Tickets.vue') },
        { path: 'tickets/:id', component: () => import('@/views/admin/Ticket.vue') },
        { path: 'ticket-categories', component: () => import('@/views/admin/TicketCategories.vue') },
        { path: 'audit-log', component: () => import('@/views/admin/AuditLog.vue') },
        {
          path: 'settings',
          alias: ['options', 'customize', 'score', 'resource'],
          component: () => import('@/views/admin/Settings.vue'),
        },
        { path: 'notifications', component: () => import('@/views/admin/Notifications.vue') },
        { path: 'translations', component: () => import('@/views/admin/Translations.vue') },
        { path: 'status', component: () => import('@/views/admin/Status.vue') },
        { path: 'update', component: () => import('@/views/admin/Update.vue') },
        { path: 'integrations', meta: { title: 'integration.title' }, component: () => import('@/views/admin/Integrations.vue') },
        { path: 'integrations/yggdrasil/logs', alias: 'yggdrasil-log', meta: { title: 'integration.yggdrasil.logs' }, component: () => import('@/views/admin/YggLogs.vue') },
        { path: 'plugins/config/:plugin', redirect: to => ({ path: '/admin/integrations', query: { module: integrationModuleForPlugin(String(to.params.plugin)) || 'oauth' } }) },
      ],
    },

    { path: '/:pathMatch(.*)*', component: () => import('@/views/NotFound.vue') },
  ],
});

router.beforeEach(async (to) => {
  const session = useSessionStore();
  const needsAuth = to.matched.some(record => record.meta.requiresAuth);
  const needsAdmin = to.path.startsWith('/admin');
  const initializing = to.path === '/auth/initialize';
  const security = to.path === '/account/security';
  const profile = to.matched.some(record => (record.aliasOf ?? record).path === '/profile');
  if (initializing || ((needsAuth || needsAdmin) && !session.loaded.value)) await session.fetchSession(initializing);
  const user = session.user.value;
  if ((needsAuth || needsAdmin) && !user) return { path: '/login', query: { redirect: to.fullPath } };
  if (initializing && user && !user.needsInitialization) return { path: '/user', replace: true };
  if ((needsAuth || needsAdmin) && user?.needsInitialization && !initializing && !security) return { path: '/auth/initialize', query: { redirect: to.fullPath } };
  if ((needsAuth || needsAdmin) && user && !user.email && !profile && !initializing && !security) return { path: '/profile' };
  if (needsAdmin && !session.isAdmin.value) return { path: '/' };
  return true;
});
