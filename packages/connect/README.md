# dsh-connect

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（**DSH**）的 Agent 接入聊天软件（飞书 / Lark 等）的**渠道无关核心层**：负责会话绑定、Agent 驱动、流式回复桥接与本地指令。

> 需要配合渠道适配器一起安装，例如 [dsh-connect-feishu](https://www.npmjs.com/package/dsh-connect-feishu)。

## 安装

```sh
dsh plugin --profile web add dsh-connect dsh-connect-feishu
```

## 完整文档

功能说明、指令清单、配置项与飞书接入步骤见 GitHub 仓库：

https://github.com/IvanWu2015/dsh-connect

## 许可

MIT
