# 02: 阿里云 ECS 阶段二 · 域名 + HTTPS + 管理面 Basic Auth

**What to build:** 备案完成后，把站点从 SSH 隧道形态切换为域名 + HTTPS 公网访问；`/manage`、`/api/manage/*`、`/api/sync/*` 受 Basic Auth 保护，阅读页与 `/api/archive/*` 保持公开，前端与后端代码零改动。

**Parent:** [spec.md](../spec.md) 决策 D1、D4

**Blocked by:** 备案通过 + 证书签发（见[运维手册](../../../docs/deployment/aliyun-ecs.md)第 11 节）。代码与配置产物已就绪，只差外部前置条件。

**Status:** needs-info

## 依据与交付边界

- [spec.md](../spec.md)：D4 记录了「只锁管理面」的路由依据（只读归档 `app.py:194-230`，写操作 `app.py:171-185`）。
- [运维手册](../../../docs/deployment/aliyun-ecs.md)：第 11 节。
- `deploy/nginx-ecs-https.conf` 已交付，realm 统一为 `"bili manage"`。
- 本票**不**实现应用层登录、账号体系、审计或凭据管理界面。

## 核验标准

- [ ] 域名完成 ICP 备案，`https://<域名>/` 可访问；首页底部悬挂备案号并链接工信部。
- [ ] 公安联网备案已在开通后 30 日内提交。
- [ ] 80 端口只返回 301 跳转到 HTTPS，不提供任何内容。
- [ ] 证书由 `acme.sh` 自动续期，`--reloadcmd` 生效；模拟续期（`acme.sh --renew --force`）后 Nginx 仍正常。
- [ ] `curl -I https://<域名>/manage` 无凭据返回 `401`，带正确凭据返回 `200`。
- [ ] `curl https://<域名>/api/manage/ups` 无凭据返回 `401`；带凭据返回 `200`。
- [ ] `curl -X POST https://<域名>/api/sync/initial` 无凭据返回 `401`（确认 `/api/sync/` 未被遗漏）。
- [ ] `curl https://<域名>/api/archive/...` **无凭据返回 200**（确认归档面未被误锁）。
- [ ] 阅读页 `/`、`/ups/:upId`、`/dynamics/:dynamicId` 无凭据可正常浏览与刷新。
- [ ] 浏览器先打开 `/manage` 完成一次登录后，管理页内所有 `/api/manage/*` 请求自动携带凭据，**不重复弹框**（验证 realm 三处一致）。
- [ ] 未认证时前端显示 `src/manage/managementApi.ts` 的固定提示文案，不出现未处理异常。
- [ ] 回退路径可用：把配置换回 `nginx-ecs-tunnel.conf` 后，SSH 隧道访问立即恢复。

## 测试与完成证据

记录备案号与审核时长、证书签发与续期方式、各 `curl` 的实际状态码、浏览器登录流程截图描述（不使用真实口令）、gzip 与缓存头观察。

**本票不承诺：** OSS 图片访问控制（公开 URL 可直接外链，加登录也不保护图片）、多用户账号体系、访问审计、暴力破解防护（Basic Auth 无锁定机制，必要时另加 fail2ban 或 WAF）。

## Comments

（待备案与证书就绪后填写）
