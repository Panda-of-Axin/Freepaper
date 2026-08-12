Freepaper 本地长期工作区
========================

推荐放置位置：D:\Freepaper

第一次：
1. 把整个 Freepaper 文件夹解压到 D 盘，最终路径最好是 D:\Freepaper
2. 双击 00_FIRST_SETUP.bat
3. 等待 GitHub 同步与 npm run verify 完成
4. 再双击 01_COMMIT_AND_PUSH.bat，把准备好的发布自动化/文档整理提交到 GitHub

以后：
- 开始工作前：02_SYNC_FROM_GITHUB.bat
- 需要终端：03_OPEN_TERMINAL_HERE.bat
- 修改完提交：01_COMMIT_AND_PUSH.bat
- 真正发布新版本：04_RELEASE_VERSION.bat

详细说明：LOCAL_WORKFLOW_ZH.md

注意：不要再为 v2.0.5 / v2.0.6 手工复制多个源码文件夹；Git tag 会保存历史版本。
