# 30: 保留归档、媒体自动联动与全分项状态

**What to build:** 在全部阅读和同步能力上完成少量全链路组合，确保停止/删除后仍能找到旧内容，编辑和评论变化能自动带动相应媒体，管理状态不报假成功。

**Parent:** [11](11-monitoring-lifecycle.md)

**Blocked by:** [14](14-scope-navigation-cards.md)、[18](18-reply-reading.md)、[20](20-dynamic-image-reading.md)、[22](22-comment-image-reading.md)、[26](26-comment-sync-status.md)、[28](28-recent-window-lifecycle.md)、[29](29-inflight-monitoring-lifecycle.md)

**Status:** ready-for-human

## 依据与交付边界

- [规格](../spec.md)：故事 43–47、50–60、67；I3–I9、I12；T1–T3。
- [SRS](../../../docs/product/SRS.md)：FR-01、FR-05、FR-10、FR-14–FR-20、DR-01–DR-05、NFR-04、NFR-05；AC-13、AC-17、AC-20–AC-30、AC-32、AC-33 的跨模块组合部分。
- 遵守[共同交付要求](../implementation-plan.md#所有执行子票的共同交付要求)。不重复实现前置能力，优先补组合契约和整合缺口；#29 负责在途竞态，本票负责最终可见业务结果。
- 不承担 Nginx 部署、实际云/上游运行或真机结论，它们分别由 #31/#33/#34 负责。

## 核验标准

- [x] 管理 UID/模式/目标→fixture 检查/同步→真实 SQLite→HTTP/生产 Adapter→列表/详情/评论图→返回至少形成一条穿透链路，OSS 仅模拟，浏览器使用受控图片服务。
- [x] 停止/删除配置、删目标、模式切换、窗口移出及上游消失后，有旧归档的 UP 仍在选择条；全部/单 UP/详情、根回复及两类媒体均可读，不只靠旧详情 URL，scope/分页/访问恢复不串。
- [x] 可信 HTML 编辑时间变化自动经公共同步更新正文与动态图来源、上传和页面；单图失败保留正文/旧成功媒体，无新信号也恢复，不用 pub_ts/内容比较触发，不回退 B站业务图。
- [x] 来源总数变化自动更新必要根回复及一级评论图；评论文本不等全图上传，图片失败不倒退评论 checkpoint，纯图评论和不同 owner 预览正确，不扩展回复图。
- [x] 管理 API/UI 聚合区分未检查、可信无变化、同步中、部分完成、失败及具体未完成项，最近检查/实际分项成功时间准确；一项成功、HTTP 可读或“发现成功”都不能冒充全部归档完成。
- [x] 正文受限/编辑信号未知不挡可读评论，计数/页/图失败不归零清档；旧/新观察交错、无新信号重试和重启在组合路径有证据，保留原读取、导航、焦点和故障回归，无旧按钮/转发/独立评论页/凭据 UI。

## 测试与完成证据

T1–T3 使用真实 SQLite、公开执行/HTTP 入口、生产 Adapter 与少量浏览器穿透；模拟外部 I/O 而非全 mock 存储。每条组合给出可复现命令和证据，虚构秘密脱敏；与 #29 核对父 #11 原清单后交给部署验收，不宣称实际持续运行已通过。

## Comments

### 实现与自动化交付

- 依据已确认 T1/T2/T3 补后端三条组合与浏览器两条穿透：管理保存→公开检查/同步→真实 SQLite→HTTP/生产 Adapter→列表/详情/根回复/两类图片→返回；停止、删目标/配置、断源重开后仍从选择条进入旧归档。近期/模式/窗口与在途矩阵复用 #28/#29 并重跑，不重复实现。
- 补正文、动态图、评论图实际成功时间及固定媒体错误聚合，生产管理 Adapter 严格兼容旧缺字段/拒绝非法字段，UI 分开显示时间、未完成项与脱敏错误；检查/发现/文本成功不冒充全部完成。无 schema 变化，不改冻结 cursor。
- 按用户补充参考脚本 sleep 区间，正式 API/采集默认来源 transport 对动态 feed 等待 0.8–1.5 秒、根评论/楼中楼页等待 0.3–0.4 秒，含首页/空尾页复查；异步共享等待不占网络锁或 SQLite，固定 15 秒调度不变。不导入 ignored 脚本、不接飞书；不保证跨进程限速或不再限流。
- 最终后端 `uv run pytest backend/tests -q --tb=short` **663 passed**；前端 `pnpm test --maxWorkers=1` **268 passed**；归档浏览器 **38 passed**、管理 **7 passed**、原 mock/故障 **104 passed/10 skipped**（Nginx 专用场景）；`pnpm typecheck`、`pnpm build`、`git diff --check` 通过。后端原虚拟节拍测试不再以数据库写入冒充 coroutine 退出，改用外部请求进展，未改生产 busy-skip 或放宽超时；双参数连续 30 次通过。
- [总验收与父 #11 对照](../acceptance-30.md)、[后端专项](../evidence/backend-lifecycle-30.md)、[浏览器专项](../evidence/frontend-lifecycle-30.md) 记录红绿、命令、并行时限问题和证据边界；正式语义见 [采集契约](../../../docs/backend/api/collector-api.md)。转 `ready-for-human` 等待维护者复核，不自动收口父票或产品 AC。
- 真实上游/OSS、持续运行、容量、Nginx 与真机未验证，归 #31–#34；自动化通过不冒称它们完成。按用户要求先双轴 review，再统一提交当前分支。
- 首轮 Standards 无硬违规、Spec 无漏项/越界/阻断缺陷；两轴共同指出评论 owner 多写无意义动态图时间，已由公开 HTTP 断言先红后绿修正。另统一分页端点常量、补总验收/浏览器证据索引、澄清行号和稳定媒体错误 key；修正后节流/整合/评论媒体专项 **38 passed**。
- Standards 与 Spec 独立增量复核均无确认问题，遗留硬违规/缺陷均为 0；审查修正后再次全量后端 **663 passed**、前端 **268 passed**，typecheck/build 通过，新增组合浏览器 **2 passed**。完成审查后统一提交当前分支。
