# 本地化资源

界面、API提示、邮件和SEO文案统一维护在 `src/locales/<locale>.json`。支持 `zh_CN`、`zh_TW`、`en`、`es_ES`、`ru_RU`、`ja_JP`，当前每种语言各有1521条消息，只有一份嵌套JSON词典。

```json
{
  "common": {
    "save": "保存",
    "count": "{count} 项"
  }
}
```

消息格式采用[Vue I18n消息语法](https://vue-i18n.intlify.dev/guide/essentials/syntax)：命名参数 `{name}`、复数分支 `item | items`、字面量 `{'@'}` 和链接消息 `@:common.save`。不新增 Laravel `:name` 占位符。键以领域分组，叶子必须是字符串，键名不包含点号；调用时仍使用 `common.save` 这样的路径。

前端加载入口为 `apps/web/src/locales/index.ts`，其他语言按需加载；`stores/i18n.ts` 统一管理语言、格式化和后台覆盖。服务端通过 `@pigeon-skin/shared/i18n` 使用Vue I18n内核；纯locale定义和消息操作分别从 `/locales`、`/messages` 导入，避免普通契约引入所有词典。

用户手册正文位于 `apps/web/src/content/manual`，中文为Markdown，其他语言在 `localized` 中；它们是文档内容，不是第二份界面词典。编辑器内嵌的第三方语言资源独立于本站词典。旧 PHP 词典仅在 `work/.../i18n-backup/legacy-php-languages.json.gz.b64` 中归档，不参与运行时。

后台翻译覆盖只接受已有消息键，必须保留插值参数和合法语法。既有Laravel格式参数在读取时按该消息声明的参数转换，保存时统一成Vue格式。前端、邮件、服务端页面使用同一份基础词典及对应locale的覆盖。

新增或修改词条时同步六种语言，运行：

```sh
python3 tools/localization/translate.py --phase validate
python3 -m unittest discover -s tools/localization -p 'test_*.py'
npm run test --workspace @pigeon-skin/shared
npm run test --workspace @pigeon-skin/web
```

翻译辅助脚本输出可审阅的补丁，不直接写入词典；`--phase translate --locale <locale>` 只补缺少的键，`--force`明确重新生成。无效JSON、错语言、大量英文回退、键缺失或插值变化会中止产出。语法编译、动态键和运行效果仍须通过测试与真实页面核验，语言特征检查不代表译名质量保证。
