# Blockbench 集成

参考项目：[JannisX11/Blockbench](https://github.com/JannisX11/blockbench)，版本 `5.2.1`，上游提交 `e2ede0809ee6bc91f374ac7e00d34cffbdf86a14`。

Blockbench 以 GPL-3.0-or-later 发布。`build-blockbench.mjs` 固定上游版本并构建官方 Web 入口，将 Blockbench Web 应用作为独立 iframe 资源发布；站点侧 Bridge 只调用公开的皮肤格式对话框、Texture、Undo 和 Paint 工作区。完整 GPL 文本随编辑器资源发布。上游变更需固定到新的提交并重新执行构建及许可证检查。

上游以 `vendor/blockbench` Git submodule 引用，父仓库只保存仓库地址和提交指针，不复制上游源码。初始化：

```sh
git submodule update --init --recursive
```

构建以父仓库 gitlink 指定的提交为输入，在 `apps/web/.cache/blockbench` 创建独立副本。启动脚本调整只作用于该副本，子模块保持原样。生成目录 `apps/web/public/blockbench` 不进入源码提交。主站 Vite 包不导入 Blockbench；站点与编辑器通过 iframe 的 `postMessage` 交换命令和 PNG。

更新版本时，在子模块中检出上游提交，再通过 `git add vendor/blockbench` 更新父仓库指针。CI 与部署工作流会初始化子模块。

部署的 `/blockbench/source.tar.gz` 包含固定版本完整上游源码、实际修改后的启动文件、锁文件及站点适配脚本，`SOURCE_NOTICE.txt` 记录修改与构建命令。`/blockbench/LICENSE.MD` 保留完整 GPL 文本。部署编辑器时同时保留这些文件和上游附带声明。

主站自有代码采用 Apache-2.0；Blockbench 及其修改按 GPL-3.0-or-later 分发。子模块是源码管理边界，不改变上游许可条款；不同程序是否属于独立作品由实际组合方式决定。[GNU 关于独立作品与聚合的说明](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)。
