# Web Mirror Session - 飞书对话同步到 DSH Web

[English](MIRROR_SESSION.md) | 中文

## 功能概述

把每个飞书聊天的 DSH 会话镜像到 DSH Web 界面，实现**跨平台查看对话历史**。飞书通道与 Web GUI 共享**同一个 DSH 会话**——相同的 session ID、相同的历史记录。

### 🎯 核心目标

- **相同的工作区**：飞书和 Web 看到相同的文件系统和目录结构
- **相同的会话**：通过共享 session ID 和历史记录，确保两边看到完全一致的对话
- **诚实的访问模型**：锁只在飞书侧生效——Web 侧实际上永远可写（见下文 [锁是单侧的](#-锁是单侧的重要)）

### ⚡ 自动同步

**connect 插件自动完成工作区与会话的同步，无需任何手动操作**：

1. **自动注册工作区**：connect 启动后自动把工作目录注册到 DSH `workspaceRegistry`，Web GUI 立即显示该工作区
2. **自动关联会话**：飞书创建的每个会话自动 attach 到对应工作区，Web GUI 看到与飞书完全相同的会话列表
3. **历史会话补录**：启动时自动把 bindings 中已有的会话补录到工作区，旧会话也出现在 Web GUI
4. **自动镜像（autoMirror）**：`autoMirror` 默认 `true`，每个新飞书聊天都会自动创建镜像会话——通常根本不需要手动执行 `/mirror`

> 💡 **无需手动配置**：只要飞书 connect 与 DSH Web 运行在同一个 DSH 进程（通过 `cordis.patch.yml` 加载），工作区和会话就自动一致。参考 [共享工作区配置](./SHARED_WORKSPACE_SETUP.zh.md)。

### 🔑 命令一览（v0.6.2）

| 命令 | 作用 |
|---|---|
| `/mirror [--timeout N]` | 为当前聊天创建（或查看状态）Web 镜像会话；可选锁超时时间（分钟） |
| `/unlock` | 手动释放会话锁 |
| `/renew` | 把当前锁的超时时间延长一个完整周期（仅锁的拥有者可续期） |
| `/export [markdown\|pdf]` | 导出对话历史（目前仅支持 Markdown；`pdf` 返回友好提示） |

---

## 镜像的工作原理

镜像本质上是**共享 binding 上的记账信息**：聊天被镜像后，其 `ChatBinding` 携带 `webMirrorSessionId`（Web GUI 打开的会话）和 `lockOwner`。DSH Web GUI 直接从 DSH 的会话存储读取会话，因此镜像会话会直接出现在 GUI 的共享工作区下。

### 🔒 锁是单侧的（重要）

`lockOwner`（`"feishu" | "web"`）**只由飞书侧的 `AgentRunner` 强制**：

- 飞书 runner 在每次任务回合前后检查 / 获取 / 释放锁。
- **DSH Web 从不经过 connect-web 适配器、从不查询锁**：Web GUI 直接读写 DSH 会话（经由 DSH 自己的 api-proxy）。实际上 Web 侧**永远可写**。
- 结论：锁可以串行化飞书侧的任务回合、记录谁"拥有"会话，但**无法阻止** Web 用户同时写入同一个会话。这是当前 DSH Web GUI 的架构限制，**无法在本仓库修复**——不要假设 Web 侧会遵守互斥锁。

### 🔒 锁的作用范围

- 锁只存在于**同一镜像会话**的 **feishu / web** 通道之间。**telegram / dingtalk 不参与锁**——`lockOwner` 只会是 `"feishu" | "web"`。

### 🔄 锁的生命周期

- 飞书回合开始时**获取**；回合结束（成功或出错）时**释放**。
- **超时自动释放**：锁超过超时时间无活动即自动释放——默认 **5 分钟**；创建时用 `/mirror --timeout N`、运行中用 `/renew` 调整。
- **手动释放**：`/unlock` 立即释放锁。
- **续期**：`/renew` 从当前时刻起把锁延长一个完整超时周期。
- **会话变更**：`/new`、`/clear` 以及切换到其他会话（`/chat`）会清除 `webMirrorSessionId` / `lockOwner`；`autoMirror` 随后为新激活的会话重建镜像。

---

## 使用方法

### 1️⃣ 创建 Web 镜像会话

在飞书中发送：

```
/mirror
```

或（别名）：

```
/web
```

**预期输出**：

```
✅ Web 镜像会话已创建：connect-c38f92c6-2d6b-450c-95c1-c2aad995aff0
在 DSH Web 中打开此会话即可查看飞书对话历史。
```

> `autoMirror: true`（默认）时通常不需要这条命令——第一条消息创建会话后镜像就已经存在。

### 2️⃣ 在 DSH Web 中查看

1. 打开 DSH Web 界面（http://127.0.0.1:3080）
2. 找到对应的工作区会话
3. 会话 ID 与飞书显示的相同
4. 可以查看完整的对话历史、任务清单、目标状态等

### 3️⃣ 查看镜像状态

在飞书中再次发送 `/mirror`：

```
Web 镜像会话：connect-c38f92c6-...
锁定方：飞书
超时时间：5 分钟
排队消息：2 条
```

### 4️⃣ 手动释放锁

如果会话被意外锁定，可以强制释放：

```
/unlock
```

**预期输出**：

```
🔓 会话锁已手动释放
```

### 5️⃣ 自定义超时时间

创建镜像时可以指定超时时间（分钟）：

```
/mirror --timeout 10
```

**预期输出**：

```
✅ Web 镜像会话已创建：connect-xxx
在 DSH Web 中打开此会话即可查看飞书对话历史。（超时时间：10 分钟）
```

### 6️⃣ 续期会话锁

如果任务较长，可以在超时前续期：

```
/renew
```

**预期输出**：

```
🔄 会话锁已续期 5 分钟
```

### 7️⃣ 导出对话历史

将当前会话的完整对话历史导出为 Markdown 文件：

```
/export
```

或指定格式（目前仅支持 Markdown）：

```
/export markdown
```

**预期输出**：

```
📄 对话历史已导出为 Markdown：
D:\projects\conversation-connect-xxx-1234567890.md
```

导出的文件包含：
- 会话 ID 和导出时间
- 所有用户和助手的消息
- 任务开始和结束的状态信息

---

## 访问控制逻辑（如实说明）

### 场景 1：飞书正在执行任务

```
飞书用户："帮我分析这个文件"
→ 飞书 runner 获取锁（锁定方 = 飞书，超时计时开始）
→ 此时 Web 用户向同一会话发消息
→ Web GUI 直接写入共享 DSH 会话（它从不查询锁）
→ 两边写入落在同一会话；锁无法阻止 Web 的写入
```

### 场景 2：任务完成，锁释放

```
飞书任务完成（或出错）
→ 自动释放锁（锁定方 = undefined）
→ 飞书侧下一条任务消息可以重新获取锁
```

### 场景 3：超时自动释放

```
飞书获得锁后 5 分钟无活动
→ 自动检测超时
→ 释放锁并通知："⏰ 会话锁已超时（5 分钟无活动），自动释放"
→ 飞书侧可以重新获取锁
```

### 场景 4：手动解锁

```
飞书侧发送 /unlock
→ 检查是否有活跃锁
→ 释放锁
→ 通知："🔓 会话锁已手动释放"
```

### 场景 5：无锁状态（初始或空闲）

```
双方都空闲
→ 飞书侧下一条任务消息会获取锁
→ Web 侧随时可写（它不检查锁）
```

---

## 技术实现

### 数据模型扩展

```typescript
interface ChatBinding {
  // ... existing fields ...

  /** Web mirror session id (shared with DSH Web for viewing). */
  webMirrorSessionId?: string;

  /** Session lock status: which channel currently owns write access. */
  lockOwner?: "feishu" | "web";
}
```

### 锁定机制

```typescript
// 获取锁（返回 true 表示成功）
acquireLock(channel: "feishu" | "web"): boolean

// 释放锁
releaseLock(): void

// 检查是否有写权限
canWrite(channel: "feishu" | "web"): boolean
```

> 这些辅助函数**只运行在飞书侧 runner 内部**；Web GUI 从不调用它们。

### 命令处理

```typescript
case "mirror": {
  await this.handleMirror(target, msg);
  break;
}
```

---

## 注意事项

### ⚠️ 重要限制

1. **单一会话**：飞书和 Web 共享同一个 DSH session ID
2. **单侧锁**：锁只在飞书侧生效；**Web GUI 永远可写**且从不查询锁——这是 DSH Web 的架构限制，无法在本仓库修复
3. **锁的作用范围**：只涉及镜像会话的 feishu / web 通道；telegram / dingtalk 不参与
4. **超时保护**：默认 5 分钟无活动自动释放（可通过 `/mirror --timeout N` 或 `/renew` 调整）
5. **锁续期**：`/renew` 延长当前锁的超时时间

### 💡 最佳实践

1. **主要交互端**：建议以飞书为主要交互端，Web 主要用来看（因为锁是单侧的，两端同时写入可能交错）
2. **避免并发**：不要在两边同时发送消息，等待一方完成后再切换
3. **定期检查**：使用 `/mirror` 查看当前锁定状态
4. **超时设置**：如果任务较长，使用 `/mirror --timeout 15` 设置更长的超时时间
5. **锁续期**：任务执行中快超时时，使用 `/renew` 延长锁的超时时间
6. **手动解锁**：遇到死锁时使用 `/unlock` 强制释放

### 🔧 故障排查

**问题**：Web 中看不到飞书对话

**解决**：
1. 确认镜像已存在（`/mirror`，或 autoMirror 自动创建）
2. 检查会话 ID 是否匹配
3. 确认 DSH Web 使用的是相同的工作区

**问题**：飞书侧一直显示"会话被占用"

**解决**：
1. 检查飞书是否有未完成的任务
2. 使用 `/stop` 停止当前任务
3. 等待锁超时（默认 5 分钟）自动释放
4. 或使用 `/unlock` 手动释放锁

---

## 未来增强

可能的改进方向：

- [ ] **Web UI 锁定状态指示**：在 DSH Web 界面显示锁定状态图标和提示（需要修改 DSH Web 源代码）
- [ ] 在 Web 侧也强制锁（需要修改 DSH Web）
- [ ] PDF 导出支持（需要额外的 PDF 生成库）
- [ ] 锁续期自定义时间（`/renew --timeout 15`）
- [ ] 自动清理过期的导出文件

> **注意**：Web UI 锁定状态指示与 Web 侧锁强制都需要修改 DSH Web 的源代码（位于 `@deepseek-ai/dsh` 项目），不在当前 `dsh_feishu` 项目范围内。

---

## 示例对话

### 飞书端

```
User: /mirror
Bot: ✅ Web 镜像会话已创建：connect-xxx
     在 DSH Web 中打开此会话即可查看飞书对话历史。

User: 帮我分析项目结构
Bot: 🔄 正在处理任务...
     [Agent 执行中...]
     ✅ 完成
```

### Web 端（同时查看）

```
[会话 connect-xxx]

👤 User: 帮我分析项目结构
🤖 Agent: [深度思考中...]
          项目包含以下模块：
          - packages/connect (核心)
          - packages/connect-feishu (适配器)
          ...

[状态：空闲，可查看完整历史]
```

---

## 相关文档

- [Binding Store](../packages/connect/src/binding.ts) - 会话绑定存储
- [Runner](../packages/connect/src/runner.ts) - 会话驱动和锁定逻辑
- [Commands](../packages/connect/src/commands.ts) - 命令解析
