# Freepaper 本地工作区（Windows / D 盘）

这个文件夹设计为 Freepaper 今后的**唯一长期工作区**。不要再为 `v2.0.5`、`v2.0.6` 等版本手工复制多个源码文件夹；历史版本由 Git commit + tag 管理。

## 第一次使用

1. 把整个 `Freepaper` 文件夹放到例如：
   `D:\Freepaper`
2. 双击：
   `00_FIRST_SETUP.bat`
3. 脚本会：
   - 检查 Git / Node.js / npm；
   - 在当前文件夹建立 `.git`；
   - 连接 `https://github.com/Panda-of-Axin/Freepaper.git`；
   - fetch `origin/main`；
   - 用 `git reset --mixed origin/main` 把当前工作区锚定到真实 GitHub 历史，**不会覆盖本包里准备好的文件**；
   - 执行 `npm run verify`。
4. 完成后，双击 `01_COMMIT_AND_PUSH.bat`，把本包中已经准备好的发布自动化/文档整理提交到 GitHub。

首次 push 时，Git for Windows 可能弹出 GitHub 登录窗口，这是正常的。使用你拥有该仓库写权限的 GitHub 账号登录即可。

## 平时开发

建议顺序：

```text
开始工作
→ 02_SYNC_FROM_GITHUB.bat
→ 修改代码
→ npm run verify
→ 01_COMMIT_AND_PUSH.bat
```

`01_COMMIT_AND_PUSH.bat` 会先显示变更、让你输入 commit message，再询问是否真正 push。

## 打开终端

双击：

`03_OPEN_TERMINAL_HERE.bat`

终端会直接位于 Freepaper 根目录，可以运行：

```bash
git status
npm run verify
npm run package:release
```

## 发布新版本

不要因为普通代码修改就创建新 Release。真正决定发布例如 `v2.0.6` 时：

1. 先在 `CHANGELOG.md` 最上方加入：
   `## 2.0.6`
   并写好本版本更新内容；
2. 确保普通开发修改已经 commit + push，工作区干净；
3. 双击：
   `04_RELEASE_VERSION.bat`
4. 输入 `2.0.6`；
5. 脚本会调用：
   `npm run release -- 2.0.6`
6. 验证成功后，经你再次确认，脚本会：
   - commit `release: Freepaper v2.0.6`；
   - push `main`；
   - 创建并 push tag `v2.0.6`；
7. GitHub Actions 会自动：
   - `npm run verify`；
   - 生成 Chrome Web Store ZIP；
   - 生成 Edge Add-ons ZIP；
   - 生成 SHA256；
   - 创建/更新 GitHub Release 并上传附件。

## 历史版本怎么查看

查看标签：

```bash
git tag
```

临时查看 v2.0.5：

```bash
git switch --detach v2.0.5
```

回到最新版：

```bash
git switch main
```

如果想同时保留旧版本目录，使用 `git worktree`，不要手工复制版本文件夹。

## 重要原则

- `D:\Freepaper` 是唯一主工作区；
- `.git` 放在 `D:\Freepaper\.git`；
- npm/git 命令都在 `D:\Freepaper` 根目录运行；
- 不再用 GitHub 网页 Upload files 覆盖整个仓库；
- 发布 ZIP 在 `dist/` 临时生成并被 `.gitignore` 忽略；
- GitHub Release 附件由 Actions 自动生成，不存进源码仓库。
