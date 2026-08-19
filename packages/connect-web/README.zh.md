# dsh-connect-web

[English](README.md) | 中文

`dsh-connect` 的 Web 渠道适配器：让 DSH Web GUI 能够自动镜像飞书会话并与之交互。

## 概述

本包在 `dsh-connect` 的镜像会话与 DSH Web GUI 之间提供一座桥梁。

**✨ 新特性：自动镜像** —— 从最新版本开始，每个飞书会话都会**自动**创建 Web 镜像。无需手动执行 `/mirror` 命令！

适配器监视 `BindingStore` 中设置了 `webMirrorSessionId`（由 dsh-connect 自动创建）的聊天，并将这些会话提供给 Web 界面使用。

## 功能特性

- **自动镜像检测**：监视 `BindingStore` 中设置了 `webMirrorSessionId` 的聊天
- **事件驱动更新**：通过变更事件实时发现新镜像
- **会话锁感知**：遵循锁的所有权，防止并发写入冲突
- **消息队列**：当飞书持有锁时将 Web 消息排队，锁释放后处理
- **兜底轮询**：定期扫描作为事件遗漏时的安全网

## 安装

添加到你的 DSH profile 配置中：

```yaml
plugins:
  connect-web: {}
```

或使用自定义选项：

```yaml
plugins:
  connect-web:
    pollIntervalMs: 2000  # Poll every 2 seconds instead of default 1s
```

## 使用

### 自动镜像（默认）

**无需任何配置！**每个飞书会话都会自动获得 Web 镜像：

1. 在飞书中与机器人开始对话
2. 打开 DSH Web GUI，地址为 http://127.0.0.1:3080
3. 会话自动出现 ✨

镜像在以下时机创建：
- 新会话启动时
- 恢复已有会话时

### 手动镜像控制（可选）

`/mirror` 命令仍然可用于查看状态：

```
/mirror
```

它会显示：
- 当前镜像会话 ID
- 锁的所有者与超时时间
- 排队消息数量

### 在 Web GUI 中查看镜像

一旦飞书中的会话开始：
1. 打开 DSH Web GUI，地址为 http://127.0.0.1:3080
2. 镜像会话自动出现
3. 你可以查看完整的会话历史
4. 发送消息（受锁所有权约束）

### 会话锁

为防止飞书与 Web 同时活跃时发生冲突：

- **锁所有者**：只有锁所有者可以发送触发智能体执行的消息
- **只读模式**：非所有者可以查看，但消息会被排队
- **超时**：锁在 5 分钟无活动后自动释放
- **手动释放**：在飞书中使用 `/unlock` 提前释放锁

### 命令

在飞书中：
- `/mirror` —— 创建或显示 Web 镜像状态
- `/unlock` —— 手动释放会话锁

在 Web GUI 中：
- 如果锁由飞书持有，消息会自动排队
- 锁释放后处理队列

## 架构

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────┐
│   Feishu    │◄───────►│   dsh-connect    │◄───────►│  DSH Web    │
│   Adapter   │         │   BindingStore   │         │   Adapter   │
└─────────────┘         └──────────────────┘         └─────────────┘
                               ▲
                               │ onChange events
                               │
                        ┌──────┴──────┐
                        │  WebAdapter │
                        │  (monitor)  │
                        └─────────────┘
```

## API 参考

### WebAdapter

```typescript
class WebAdapter implements ChannelAdapter {
  constructor(bindings: BindingStore, options?: { pollIntervalMs?: number });
  
  // Check if a session is mirrored
  isSessionMirrored(sessionId: string): boolean;
  
  // Get the source chat key for a mirrored session
  getMirrorSource(sessionId: string): string | undefined;
  
  // Get lock status for a session
  getSessionLock(sessionId: string): "feishu" | "web" | undefined;
  
  // Check if Web can write to a session
  canWrite(channel: string, chatKey: string): boolean;
  
  // Queue a message for later processing
  queueMessageForSession(channel: string, chatKey: string, text: string, senderKey: string): number;
}
```

### BindingStore 扩展

`BindingStore` 已扩展以下能力：

```typescript
// Subscribe to binding changes
onChange(callback: (binding: ChatBinding, changeType: "add" | "update" | "delete") => void): () => void;

// Iterate over all bindings
entries(): IterableIterator<ChatBinding>;
list(): ChatBinding[];

// Find bindings by webMirrorSessionId
findByWebMirror(sessionId: string): ChatBinding[];
```

## 配置

| 选项 | 类型 | 默认值 | 说明 |
|--------|------|---------|-------------|
| `pollIntervalMs` | number | 1000 | 镜像检测的轮询间隔（毫秒） |

## 故障排查

### Web GUI 中不显示镜像

1. 确认已在飞书中成功发送 `/mirror`
2. 在 DSH 日志中查找 `connect-web: Web adapter registered` 消息
3. 确保 `dsh-connect` 服务先于 `connect-web` 加载

### 无法从 Web 发送消息

1. 检查锁状态：飞书当前是否正在执行任务？
2. 等待锁超时（5 分钟）或在飞书中使用 `/unlock`
3. 确认消息出现在队列中（查看日志）

### CPU 占用过高

降低轮询频率：
```yaml
plugins:
  connect-web:
    pollIntervalMs: 5000  # Poll every 5 seconds
```

## 许可

MIT
