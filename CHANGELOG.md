# Changelog

## 1.4.0

- Replaced runtime and store icons with the new high-resolution Freepaper artwork;
- added English and Simplified Chinese manifest localization through `_locales`;
- added an in-app language selector with Auto, 简体中文, and English modes;
- localized the popup, control center, task monitor, and draggable verification assistant;
- added English and Chinese GitHub READMEs and bilingual privacy/store-submission documents;
- retained the v1.3.8 Freepaper-only Recent downloads mechanism.

## 1.3.8

- “最近下载”改为 Freepaper 专属下载登记机制；
- 只显示由 Freepaper 创建并跟踪的下载任务；
- 不再读取或混入浏览器全局 PDF 下载历史；
- Service Worker 重启后仍可恢复已登记的下载 ID；
- 保留 1.3.7 的开源清理、安全 DOM 渲染、CSV 公式注入防护和无本地后端架构。

## 1.3.7

- 删除不再使用的 Python/桌面后端轮询与消息协议；
- 删除历史实现和停用适配器；
- 导入内容、URL、文件名和任务列表改用安全 DOM API 渲染；
- CSV 报告增加电子表格公式注入防护；
- 添加 MPL-2.0、品牌政策、安全政策、贡献指南和 GitHub CI。
