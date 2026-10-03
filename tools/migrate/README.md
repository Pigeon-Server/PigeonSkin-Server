# 旧站数据迁移

在仓库根目录安装依赖后运行：

```sh
npm run migrate:legacy -- --help
npm run migrate:legacy -- analyze --db <数据库文件> --textures <纹理目录>
npm run test --workspace @pigeon-skin/migrate
```

需要 Node.js 22.18+，使用仓库根目录的 npm workspaces 和 `package-lock.json`，统一从根目录安装依赖。支持的命令与参数以 `--help` 为准，先执行 `analyze` 检查异常，再进行迁移和核对。密码算法与时区必须按旧站实际配置指定，不要猜测。

数据库输入、输出、纹理、检查点和报告均应位于仓库外。旧密码哈希、邮箱、私钥、OAuth 凭据和日志都属于敏感内容；真实迁移数据不能作为示例提交。内置测试在临时目录构造虚构旧库，不需要生产快照。
