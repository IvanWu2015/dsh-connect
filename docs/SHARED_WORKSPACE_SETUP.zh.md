# 共享工作区配置指南

[English](SHARED_WORKSPACE_SETUP.md) | 中文

## 🎯 目标

确保飞书和 DSH Web 看到**完全相同的工作区、会话历史和文件**。

## ✨ 自动化（无需手动配置）

**connect 插件会自动完成所有工作区/会话关联**，无需任何手动配置：

1. **自动注册工作区**：connect 首次收到消息时，自动把工作目录注册到 DSH 的 `workspaceRegistry`，Web GUI 会立即显示该工作区
2. **自动关联会话**：飞书创建的每个会话（`connect-*`）自动 attach 到对应工作区，Web GUI 与飞书看到**完全相同的会话列表**
3. **历史会话补录**：启动时自动把 bindings 中已记录的会话补录到工作区，旧会话也会出现在 Web GUI
4. **零配置**：不需要用户执行 `/mirror`、不需要手动添加工作区、不需要设置环境变量

> 你只需要**确保飞书和 DSH Web 运行在同一个 DSH 进程/配置**（即 connect 插件通过 `cordis.patch.yml` 加载到 DSH 的 web profile 中——当前部署已是如此），其余全部自动完成。

---

## 📋 手动配置（可选，仅当你需要覆盖默认值时）

### 1️⃣ 创建共享配置文件

在项目根目录创建 `dsh.shared.config.json`：

```json
{
  "workspace": {
    "defaultWorkDir": "D:\\ACOINFO\\code\\dsh_feishu",
    "additionalWorkspaces": [
      "D:\\ACOINFO\\code\\dsh_feishu\\packages",
      "D:\\ACOINFO\\code\\dsh_feishu\\docs"
    ]
  },
  
  "state": {
    "stateDir": ".dsh-connect",
    "sessionStorePath": ".dsh/sessions"
  },
  
  "mirror": {
    "autoCreate": true,
    "defaultTimeoutMinutes": 5,
    "enableLocking": true
  },
  
  "language": "zh"
}
```

### 2️⃣ 配置飞书 Connect

飞书的 `ConnectService` 会自动读取 `dsh.shared.config.json`。

确保你的启动代码中：

```typescript
import { ConnectService } from "@deepseek-ai/dsh-connect";

// 不需要手动指定 workDir，会从共享配置读取
const connect = new ConnectService(ctx, {
  // 其他配置...
});
```

### 3️⃣ 配置 DSH Web

DSH Web 需要指向**相同的工作目录和状态目录**。

#### 方法 A：通过环境变量（推荐）

在启动 DSH Web 时设置：

```bash
# Windows PowerShell
$env:DSH_WORK_DIR="D:\ACOINFO\code\dsh_feishu"
$env:DSH_STATE_DIR=".dsh-connect"
pnpm run dev:web

# 或者在 .env 文件中
DSH_WORK_DIR=D:\ACOINFO\code\dsh_feishu
DSH_STATE_DIR=.dsh-connect
```

#### 方法 B：通过 DSH 配置文件

在 DSH Web 的配置文件中（通常是 `dsh.config.ts` 或类似文件）：

```typescript
export default {
  workspace: {
    defaultPath: "D:\\ACOINFO\\code\\dsh_feishu",
    additionalPaths: [
      "D:\\ACOINFO\\code\\dsh_feishu\\packages",
      "D:\\ACOINFO\\code\\dsh_feishu\\docs",
    ],
  },
  state: {
    dir: ".dsh-connect",
  },
};
```

### 4️⃣ 验证配置

#### 检查飞书端

在飞书中发送：

```
/status
```

应该看到：

```
状态：空闲
模型：deepseek/deepseek-chat
工作目录：D:\ACOINFO\code\dsh_feishu
待处理消息：0 （队列空）
上次任务：✅ 完成
完成时间：10:30:00
会话：connect-xxx-xxx-xxx
上下文：1234 tokens（会话 567）
```

#### 检查 Web 端

1. 打开 DSH Web（http://127.0.0.1:3080）
2. 查看工作目录是否显示为 `D:\ACOINFO\code\dsh_feishu`
3. 查看会话列表，应该能看到飞书创建的会话

#### 检查文件系统

在工作目录中应该看到：

```
D:\ACOINFO\code\dsh_feishu\
├── .dsh-connect\
│   ├── bindings.json          # 会话绑定信息（共享）
│   └── ...
├── .dsh\
│   └── sessions\              # 会话历史（共享）
│       ├── connect-xxx\
│       │   ├── events.jsonl
│       │   └── ...
│       └── ...
├── dsh.shared.config.json     # 共享配置文件
└── ...
```

---

## 🔍 关键文件说明

### `bindings.json`

位置：`.dsh-connect/bindings.json`

这是**飞书和 Web 共享的核心文件**，包含：

```json
[
  {
    "channel": "feishu",
    "chatKey": "oc_xxx",
    "chatType": "p2p",
    "sessionId": "connect-xxx-xxx-xxx",
    "ownerKey": "ou_xxx",
    "createdAt": 1234567890,
    "lastActiveAt": 1234567890,
    "webMirrorSessionId": "connect-xxx-xxx-xxx",
    "lockOwner": "feishu",
    "lockAcquiredAt": 1234567890,
    "lockTimeoutMs": 300000,
    "queuedMessages": [],
    "sessions": [
      {
        "sessionId": "connect-xxx-xxx-xxx",
        "title": "帮我分析项目",
        "createdAt": 1234567890,
        "lastActiveAt": 1234567890,
        "workDir": "D:\\ACOINFO\\code\\dsh_feishu"
      }
    ]
  }
]
```

**关键字段**：
- `sessionId`：飞书和 Web 通过这个 ID 找到同一个会话
- `workDir`：确保两边使用相同的工作目录
- `webMirrorSessionId`：标记这个会话已镜像到 Web

### `events.jsonl`

位置：`.dsh/sessions/connect-xxx/events.jsonl`

这是**会话的完整历史记录**，包含所有用户消息、助手回复、任务事件等。

飞书和 Web **都读取这个文件**，所以看到的是完全相同的历史。

---

## ⚠️ 常见问题

### Q1: 飞书和 Web 看到的工作目录不同？

**原因**：DSH Web 没有正确配置工作目录。

**解决**：
1. 检查 DSH Web 的环境变量或配置文件
2. 确保 `DSH_WORK_DIR` 或 `workspace.defaultPath` 与飞书一致
3. 重启 DSH Web

### Q2: Web 看不到飞书的会话？

**原因**：`bindings.json` 没有被 Web 读取。

**解决**：
1. 确认飞书和 Web 使用相同的 `stateDir`（默认 `.dsh-connect`）
2. 检查 `.dsh-connect/bindings.json` 是否存在
3. 确认 `webMirrorSessionId` 字段已设置

### Q3: 飞书创建的文件，Web 看不到？

**原因**：工作目录不同。

**解决**：
1. 确认两边的 `workDir` 完全一致（包括大小写和路径分隔符）
2. 使用绝对路径，避免相对路径导致的差异
3. 检查文件系统权限

### Q4: 会话历史不同步？

**原因**：DSH session 文件没有被共享。

**解决**：
1. 确认飞书和 Web 使用相同的 `sessionStorePath`
2. 检查 `.dsh/sessions/` 目录是否存在且可读写
3. 确保没有多个独立的 DSH 实例在运行

---

## 🧪 测试流程

### 测试 1：工作目录一致性

1. 在飞书中发送：`/status`
2. 记录显示的"工作目录"
3. 在 DSH Web 中查看工作目录设置
4. 两者应该完全一致

### 测试 2：会话同步

1. 在飞书中发送：`/mirror`
2. 记录显示的会话 ID
3. 在 DSH Web 中查找该会话 ID
4. 应该能看到相同的会话

### 测试 3：文件可见性

1. 在飞书中让 Agent 创建一个文件：
   ```
   请在当前工作目录创建一个 test.txt 文件，内容为 "Hello from Feishu"
   ```
2. 在 DSH Web 的文件浏览器中查找 `test.txt`
3. 应该能看到该文件并查看内容

### 测试 4：历史一致性

1. 在飞书中进行几轮对话
2. 在 DSH Web 中打开同一个会话
3. 应该看到完全相同的对话历史

---

## 📝 最佳实践

1. **使用绝对路径**：避免相对路径导致的不一致
2. **统一配置源**：所有通道都从 `dsh.shared.config.json` 读取配置
3. **定期检查**：使用 `/status` 命令验证工作目录是否正确
4. **备份配置**：定期备份 `dsh.shared.config.json` 和 `bindings.json`
5. **版本控制**：将 `dsh.shared.config.json` 加入 Git（但不包括 `.dsh-connect/` 和 `.dsh/`）

---

## 🔗 相关文档

- [Web Mirror Session](./MIRROR_SESSION.zh.md) - 飞书与 Web 的镜像机制
- [增强功能总结](./ENHANCEMENTS_SUMMARY.zh.md) - 所有已实现的功能
- [Binding Store API](../packages/connect/src/binding.ts) - 会话绑定的技术细节

---

**更新日期**：2024-01-15  
**版本**：v0.5.1
