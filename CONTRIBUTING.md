# 贡献指南

欢迎通过 [Issue 和 Pull Request](https://github.com/Pigeon-Server/PigeonSkin-Server) 贡献修复、翻译和功能。安全问题请遵循 [SECURITY.md](SECURITY.md)。

使用 Node.js 22.18 或更新的受支持版本，以及 npm 10+。安装和本地启动见 [README.md](README.md)。提交前运行：

```sh
npm run typecheck
npm run build --workspace @pigeon-skin/web
npm test
npm run check:public
```

注意先构建 web（API 测试经 wrangler 配置挂载 `apps/web/dist` 作为 SPA 资产，目录缺失时测试无法启动）。

修改应围绕明确需求，保留 Minecraft 协议、权限与迁移兼容性。前端使用 `@/` 别名和 Material Design Icons；新增文案应补齐 `zh_CN`、`zh_TW`、`en`、`es_ES`、`ru_RU`、`ja_JP`，并检查插值参数和各语言原始词典。

测试数据请使用虚构账号、保留示例域名和临时生成的密钥。不要提交运行时数据、内部地址、工作记录或 agent 报告。引入第三方代码、字体、图片和模型时，提供来源、准确版本、许可证及必要声明，并更新 [第三方说明](docs/THIRD_PARTY.md)。

提交本人拥有授权的贡献，默认同意按 Apache-2.0 发布。第三方内容保留其原许可证；不得把 GPL 编辑器、专有模型或未知来源资源标为 Apache-2.0。Pull Request 请说明最终行为与已执行的验证，提交信息准确描述结果。
