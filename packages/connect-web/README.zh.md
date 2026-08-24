# dsh-connect-web

[English](README.md) | 中文

面向 [dsh-connect](https://www.npmjs.com/package/dsh-connect) 的 Web 渠道适配器：跟踪哪些会话被**镜像**到 DSH Web GUI。它监视绑定路由存储中已镜像的聊天（`webMirrorSessionId` 已设置——由 `dsh-connect` 为每个新聊天自动创建），使 GUI 可以打开共享会话。

## 它做什么

- **镜像跟踪** —— 监视 `BindingStore`（通过 `onChange` 事件加兜底轮询），记录每个镜像会话：`isSessionMirrored(sessionId)` 与 `getMirrorSource(sessionId)`（返回 `"channel:chatKey"`）。
- **不合成入站消息** —— 镜像检测纯粹是簿记。本适配器刻意**不**为"镜像已创建"发出入站消息，因为那会启动一个多余的 `web` runner，白白消耗一次真实的 agent turn。
- **出站方法为契约空操作** —— `sendText` / `sendCard` / `streamText` / `promptChoice` / `closeMenu` 仅用于满足 `ChannelAdapter` 接口。Web GUI 直接渲染 DSH 共享会话存储中的 agent 会话事件，而不是通过适配器调用。
- **锁互斥是单侧的** —— 镜像"锁"（binding 中的 `lockOwner`）**仅由 `dsh-connect` 在飞书一侧**执行。Web GUI 直接读取镜像会话，从本仓库的角度看它是永远可写的；这种不对称无法在本包内修复。

## 安装

```sh
dsh plugin --profile web add dsh-connect dsh-connect-web
```

需要先加载 `dsh-connect` 服务（通过 `inject: ["connect"]` 声明），并通过 `dsh-connect` 的公开 `bindingStore` getter 读取绑定存储（类型来自 `dsh-connect/binding` 导出子路径）。

## 配置

这些插件会通过各自的 bundle 清单自动注册，因此这里只需要**覆盖（override）**它们的配置——**不要**再用 `insert` 重新插入（重复的 `id` 会让 dsh 启动失败）：

```yaml
- id: connect
  name: dsh-connect
- id: connect-web
  name: dsh-connect-web
  config:
    # pollIntervalMs: 1000   # 兜底镜像扫描间隔（默认 1000）
```

| 键 | 默认值 | 说明 |
|---|---|---|
| `pollIntervalMs` | `1000` | 事件遗漏时检测新镜像会话的兜底轮询间隔（毫秒） |

## API

```ts
class WebAdapter implements ChannelAdapter {
  readonly id = "web";
  isSessionMirrored(sessionId: string): boolean;                    // 该 DSH 会话是否来自某个聊天的镜像？
  getMirrorSource(sessionId: string): string | undefined;           // 来源聊天的 "channel:chatKey"
  // sendText / sendCard / streamText / promptChoice / closeMenu —— 契约空操作
}
```

## 限制

- **无入站通道**：在 Web GUI 中输入的消息不会经过此适配器路由；GUI 直接与共享的 DSH 会话交互。
- **对 Web 写入方无锁保证**：互斥锁是单侧的（仅由飞书适配器的 runner 执行）。
- **镜像可见性依赖 `dsh-connect`**：如果 `connect` 服务或其 `bindingStore` 不可用，镜像检测将被禁用（记录一条警告日志）。

## 许可

MIT
