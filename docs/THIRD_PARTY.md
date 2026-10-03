# 第三方代码与资源

项目自有代码使用 Apache-2.0，第三方代码、字体、图片、模型和音频保留原许可证。主许可证不能授予第三方商标、角色、声音或素材的使用权。

## 代码与依赖

| 内容 | 来源与许可 | 发布要求 |
|---|---|---|
| Blessing Skin 业务、翻译与继承代码 | [bs-community/blessing-skin-server](https://github.com/bs-community/blessing-skin-server)，MIT | 保留 [完整 MIT 声明](../licenses/BlessingSkin-MIT.txt) 与作者署名 |
| 纹理渲染算法 | [bs-community/texture-renderer](https://github.com/bs-community/texture-renderer)，MIT | 保留 [渲染器 MIT 声明](../licenses/TextureRenderer-MIT.txt) |
| Blockbench 编辑器 | `vendor/blockbench` Git submodule，[上游](https://github.com/JannisX11/blockbench)，GPL-3.0-or-later | 版本由父仓库 gitlink 固定；独立 iframe 资源保留 GPL 文本、修改声明与对应源码 |
| DOMPurify | MPL-2.0 OR Apache-2.0 | 可选 Apache-2.0，保留原声明 |
| node-forge | BSD-3-Clause OR GPL-2.0 | 可选 BSD-3-Clause，保留原声明；不是必须采用 GPL 的单许可依赖 |
| lightningcss 与平台二进制 | MPL-2.0 | 构建工具；再分发其二进制或修改源码时履行文件级源码与声明义务 |
| sharp 的 libvips 平台二进制 | LGPL-3.0-or-later，附带组件另有许可 | 迁移/构建工具；发布含原生二进制的工具包或镜像时保留完整声明、对应源码与 LGPL 替换/重新链接义务，不归入 Apache 授权 |
| Material Design Icons iconfont | Google Material Icons 衍生字体包，Apache-2.0 | 保留实际包中的 LICENSE，不能用其他名称相近的图标包许可代替 |

工作区已安装依赖的许可索引见 [dependencies.json](../licenses/dependencies.json)，按根目录 `package-lock.json` 与已安装包的实际版本和声明记录，包含开发依赖及本机可用的可选包；不是跨平台所有二进制的授权结论。锁文件内未安装的平台包和 Blockbench 的 npm 依赖须随各自发行物再次核对。

除表中 GPL 编辑器、LGPL 原生组件和 MPL 构建工具外，本次工作区声明未发现单许可 AGPL 或 SSPL 包。许可证元数据不能替代每个软件包内的 LICENSE/NOTICE；构建会收集已安装依赖的原始声明到 `/third-party/`，发行工具包或镜像前仍须核对完整内容。

Blockbench 上游源码仅通过子模块引用，在独立构建副本中生成编辑器资源；主站通过 iframe 消息协议交换命令与 PNG，不导入编辑器源码。编辑器及其修改保留 GPL-3.0-or-later，构建产物同时提供对应源码。构建与许可证边界见 [Blockbench 集成](BLOCKBENCH.md)。

## 运行库与素材来源

| 文件范围 | 来源 | 使用位置与说明 |
|---|---|---|
| `apps/web/public/live2d/runtime/live2dcubismcore.min.js` | Live2D Inc.，[文件头引用的许可](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) | Cubism 3/4 模型的 Core，由 `loadLive2DCore(4)` 加载，再交给 `pixi-live2d-display/cubism4` 使用；保留文件头声明 |
| `apps/web/public/live2d/runtime/live2d2.js` | Live2D 2 运行库 | Cubism 2 模型的 Core，由 `loadLive2DCore(2)` 加载，再交给 `pixi-live2d-display/cubism2` 使用 |
| `apps/web/public/live2d/models/Suzukaze-Aoba` | Suzukaze Aoba 公开模型资源 | 内置模型的贴图、动作和语音 |
| `packages/shared/src/live2d-catalog.ts` | [imuncle/live2d 固定提交](https://github.com/imuncle/live2d/tree/b5caf5390c8c226f19c817ea37d5bc4452d85209) | 远程模型目录，模型、贴图和语音按需加载；版权归原公司或个人，保留[来源说明](https://github.com/imuncle/live2d/blob/b5caf5390c8c226f19c817ea37d5bc4452d85209/README.md) |
| `apps/web/src/fonts/minecraft.woff*` | 项目现有 Minecraft 风格字体 | 页眉与侧栏品牌字体 |
| `packages/shared/src/default-skins.ts`、`official-textures.ts` | 默认皮肤与 Mojang/Minecraft Wiki 材质目录 | 默认角色预览、官方材质目录；条目保留来源地址 |
| `apps/web/public/assets/preview-backgrounds`、`beian.svg` | 项目现有 SVG 资源 | 材质预览背景、备案链接图标 |
| Blockbench 随附字体、图标、图片、worker | 上游发行资源 | 随编辑器保留原始资源、许可证和声明 |

素材、字体与运行库保留原来源和版权信息，不纳入项目自有代码的 Apache-2.0 授权。

`apps/web/public/manual` 中的产品截图由本项目自行制作，采用 Apache-2.0，与项目文档一同发布。
