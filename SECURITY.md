# 安全政策

请通过 [GitHub 私密漏洞报告](https://github.com/Pigeon-Server/PigeonSkin-Server/security/advisories/new) 提交安全问题。仓库维护者需要先启用 Private vulnerability reporting；若入口不可用，请先在普通 Issue 中仅请求私密联系方式，不要公开漏洞细节或凭据。

报告请包含受影响版本、可复现步骤、预期与实际行为、影响范围及脱敏后的证据。不要提供真实用户数据库、密码哈希、会话、OAuth 授权码、MFA 密钥或私钥。请只在自己的环境和授权账号中验证。

安全修复面向默认分支的最新代码，尚无旧版本支持承诺。

部署前应分别生成 `SESSION_SECRET`、`MFA_ENCRYPTION_KEY` 和 `SETUP_TOKEN`，通过 Cloudflare Secrets 配置。预览与生产必须使用独立的 D1、R2 和密钥。安装完成后删除 `SETUP_TOKEN`；旧密码升级完成后删除 `LEGACY_SALT`。

数据库、R2 上传、日志、迁移报告、私钥和本地 Wrangler 状态属于运行时数据，不得提交。管理员配置中的邮件、OAuth、搜索引擎凭据同样属于敏感信息，导出数据库前必须处理。私密材质从公开皮肤库隐藏，但已应用到角色的材质仍可经游戏协议匿名读取，请勿将该机制当作保密文件存储。

发现已提交的凭据后，先撤销或轮换，再清理所有相关分支、标签及导出副本。删除当前文件或加入 `.gitignore` 不会清理 Git 历史。上传源码前运行 `npm run check:public` 并保留第三方许可证和版权声明；该检查范围为文本内容与文件路径，不涵盖二进制资源内容。
