# PR #2 对 Freepaper v2.0.5 的参考价值评估

PR #2：`fix: audit fixes for v1.4.0 (IEEE download, SD detection, race conditions, UX)`

## 结论

**仍然有参考意义，但不建议直接 merge / cherry-pick 整个 PR。**

原因是 PR #2 基于较早的 v1.4.0 代码，而 Freepaper 在 v2.0.1–v2.0.5 已重构了认证、PDF 页面上下文下载、知网 DOI 跳转和任务状态机。最合适的做法是把 PR #2 当作一次“代码审计清单”，逐项移植仍然成立的修复，而不是直接合并旧 diff。

## 逐项判断

| PR #2 项目 | v2.0.5 状态 | 建议 |
|---|---|---|
| IEEE `.jsp` 被 `.js` 静态资源规则误杀 | **已经用等价方式修复** | 不需要再移植 |
| ScienceDirect 旧代码块嵌套错误 | **旧结构已被重构** | 不需要照搬 |
| ScienceDirect 根据 PII 构造 `/pdfft` | **不建议直接照搬** | v2.0.2 后动态 PDF 强调页面上下文；盲目构造/二次请求可能重新引入 HTML challenge |
| 批量完成区域重复渲染 `TypeError` | **仍有价值，v2.0.5 仍存在相似写法** | 建议下一补丁修复 |
| `sd_state` 导航/标签事件并发读改写竞态 | **仍有价值** | 高优先级；建议引入统一互斥读-改-写 |
| Service Worker 恢复后论文长期停在 `downloading` | **仍有价值** | 高优先级；加入有限恢复次数/失败后继续队列 |
| Popup 在状态刷新时反复切回批量页 | **仍有价值** | 中优先级 UX 修复 |
| Overlay 把 `updatedAt` 放入 render key 导致心跳时重建 | **仍有价值** | 中优先级 UX/稳定性修复 |
| `runtime.sendMessage()` 缺少 `.catch()` | **部分仍存在** | 可作为鲁棒性清理 |
| `tabs.query()` 空结果保护 | **部分路径仍值得补充** | 可作为鲁棒性清理 |
| 构建版本号改用 `runtime.getManifest().version` | **仍有维护价值** | 低风险、建议采用 |
| 移除重复 i18n 键/死代码 | **仍有价值** | 清理项，不阻塞当前发布 |

## 对当前 v2.0.5 最有意义的 4 项

1. **任务状态并发写互斥**：多个 `webNavigation` / `tabs` 事件可能同时执行 `getSdTask() → 修改 → saveSdTask()`，存在旧状态覆盖新状态的风险。
2. **Service Worker 恢复保护**：MV3 Worker 被回收后，如果论文停在 `downloading`，应有有限恢复次数，防止无限重开或永久卡队列。
3. **批量完成面板重复渲染**：建议给摘要文本固定 ID，不再依赖 `div:last-child`。
4. **浮窗/Popup 的重复重绘和自动切页**：心跳更新时间不应触发整个 Shadow DOM 重建，也不应每次状态刷新都强制切回批量标签页。

## 发布建议

**v2.0.5 先按当前已实测版本发布，不在发布前临时混入 PR #2。**

当前 CNKI/CHNDOI 流程刚完成真实回归测试，此时直接吸收旧 PR 的并发和状态机改动会扩大回归面。更稳妥的安排是：

- v2.0.5：发布当前已验证版本；
- v2.0.6：以 PR #2 为审计参考，选择性移植仍成立的稳定性/UX 修复；
- v2.0.6 修改后重点回归 IEEE、ScienceDirect、Wiley、CNKI 以及 Service Worker 恢复场景。
