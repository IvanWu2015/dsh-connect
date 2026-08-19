# Web Mirror Session - Syncing Feishu Conversations to DSH Web

English | [中文](MIRROR_SESSION.zh.md)

## Overview

Sync Feishu conversation content to the DSH Web interface in real time for **cross-platform viewing of conversation history**. It uses a **shared session + smart locking mechanism** to ensure data consistency and access safety.

### 🎯 Core Goals

- **Same workspace**: Feishu and Web see the same file system and directory structure
- **Same session**: through a shared session ID and history, both sides see exactly the same conversation
- **Mutual exclusion**: when one side is executing a task, the other side automatically enters read-only mode

### ⚡ Automatic Sync (Enhanced)

**The connect plugin now automatically syncs the workspace and sessions — no manual steps are required**:

1. **Automatic workspace registration**: after connect starts, the working directory is automatically registered with the DSH `workspaceRegistry`, and the Web GUI displays the workspace immediately
2. **Automatic session association**: every session created by Feishu is automatically attached to its workspace, and the Web GUI shows exactly the same session list as Feishu
3. **Historical session backfill**: on startup, sessions already present in the bindings are automatically backfilled into the workspace, so old sessions also appear in the Web GUI

> 💡 **No manual configuration needed**: as long as the Feishu connect and DSH Web run in the same DSH process (loaded via `cordis.patch.yml`), the workspace and sessions stay consistent automatically. See [Shared Workspace Setup](./SHARED_WORKSPACE_SETUP.md).

### ✨ Enhancements (v0.5.1)

- ⏰ **Timeout protection**: the lock is released automatically after 5 minutes of inactivity to prevent deadlocks
- 🔓 **Manual unlock**: the `/unlock` command forcibly releases the session lock
- 📥 **Message queue**: Web-side messages are queued automatically and **executed automatically** once the lock is released
- 📊 **Enhanced status**: `/mirror` shows the timeout duration and the number of queued messages
- 🔄 **Custom timeout**: `/mirror --timeout 10` sets a custom timeout duration
- ⏱️ **Lock renewal**: `/renew` extends the current lock's timeout
- 📄 **History export**: `/export [markdown|pdf]` exports the conversation history

---

## Core Features

### 🔒 Mutual Exclusion Access Control

- **Automatic locking**: when one side (Feishu or Web) is executing a task, the other side automatically enters **read-only mode**
- **Smart release**: the lock is released automatically after the task finishes, so the other side can continue
- **Status indication**: clearly shows the current lock holder and access permission

### 📊 Real-time Sync

- Messages sent in Feishu → immediately visible in Web
- History viewed in Web → exactly the same as Feishu
- Both share the same DSH session, with no data latency

### 🌐 Multi-end Viewing

- **Feishu**: normal chat interaction (send messages, receive replies)
- **DSH Web**: view the full conversation history, task status, and context information
- **Bidirectional visibility**: operations on either side are reflected in the same session

---

## Usage

### 1️⃣ Creating a Web Mirror Session

Send this in Feishu:
```
/mirror
```

Or:
```
/web
```

**Expected output**:
```
✅ Web 镜像会话已创建：connect-c38f92c6-2d6b-450c-95c1-c2aad995aff0
在 DSH Web 中打开此会话即可查看飞书对话历史。
```

### 2️⃣ Viewing in DSH Web

1. Open the DSH Web interface (http://127.0.0.1:3080)
2. Find the corresponding workspace session
3. The session ID is the same as the one shown in Feishu
4. You can view the full conversation history, task lists, goal status, etc.

### 3️⃣ Checking Mirror Status

Send `/mirror` again in Feishu:
```
Web 镜像会话：connect-c38f92c6-...
锁定方：飞书
超时时间：5 分钟
排队消息：2 条
```

### 4️⃣ Releasing the Lock Manually

If the session is locked unexpectedly, you can force-release it:
```
/unlock
```

**Expected output**:
```
🔓 会话锁已手动释放
✅ 已处理队列中的 2 条消息
```

### 5️⃣ Custom Timeout

You can specify the timeout (in minutes) when creating a mirror:
```
/mirror --timeout 10
```

**Expected output**:
```
✅ Web 镜像会话已创建：connect-xxx
在 DSH Web 中打开此会话即可查看飞书对话历史。（超时时间：10 分钟）
```

### 6️⃣ Renewing the Session Lock

If a task is long, you can renew it before the timeout:
```
/renew
```

**Expected output**:
```
🔄 会话锁已续期 5 分钟
```

### 7️⃣ Exporting Conversation History

Export the current session's full conversation history as a Markdown file:
```
/export
```

Or specify a format (currently only Markdown is supported):
```
/export markdown
```

**Expected output**:
```
📄 对话历史已导出为 Markdown：
D:\projects\conversation-connect-xxx-1234567890.md
```

The exported file contains:
- The session ID and export time
- All user and assistant messages
- Status information for task start and end

---

## Access Control Logic

### Scenario 1: Feishu Is Executing a Task

```
飞书用户："帮我分析这个文件"
→ Agent 开始执行（锁定方 = 飞书，超时计时开始）
→ Web 用户尝试发送消息
→ 消息加入队列（位置 1）
→ 收到提示："📥 消息已加入队列（第 1 位），等待锁释放后自动执行"
```

### Scenario 2: Task Complete, Lock Released

```
飞书任务完成
→ 自动释放锁（锁定方 = undefined）
→ 处理队列中的消息
→ 通知："✅ 已处理队列中的 1 条消息"
→ Web 用户可以发送消息
```

### Scenario 3: Timeout Auto-Release

```
飞书获得锁后 5 分钟无活动
→ 自动检测超时
→ 释放锁并通知："⏰ 会话锁已超时（5 分钟无活动），自动释放"
→ 双方都可以重新获取锁
```

### Scenario 4: Manual Unlock

```
任意一方发送 /unlock
→ 检查是否有活跃锁
→ 释放锁并处理队列
→ 通知："🔓 会话锁已手动释放"
```

### Scenario 5: No Lock (Initial or Idle)

```
双方都空闲
→ 谁先发送消息，谁获得锁
→ 另一方可以查看但不能干扰
```

---

## Technical Implementation

### Data Model Extension

```typescript
interface ChatBinding {
  // ... existing fields ...
  
  /** Web mirror session id (shared with DSH Web for viewing). */
  webMirrorSessionId?: string;
  
  /** Session lock status: which channel currently owns write access. */
  lockOwner?: "feishu" | "web";
}
```

### Locking Mechanism

```typescript
// Acquire the lock (returns true on success)
acquireLock(channel: "feishu" | "web"): boolean

// Release the lock
releaseLock(): void

// Check whether the channel has write permission
canWrite(channel: "feishu" | "web"): boolean
```

### Command Handling

```typescript
case "mirror": {
  await this.handleMirror(target, msg);
  break;
}
```

---

## Notes

### ⚠️ Important Limitations

1. **Single session**: Feishu and Web share the same DSH session ID
2. **Mutually exclusive writes**: only one side can send messages to the Agent at a time
3. **Timeout protection**: by default the lock is released automatically after 5 minutes of inactivity (customizable via `/mirror --timeout N`)
4. **Automatic queue execution**: Web-side messages are queued and **executed automatically** once the lock is released (no manual trigger needed)
5. **Lock renewal**: use the `/renew` command to extend the current lock's timeout

### 💡 Best Practices

1. **Primary interaction end**: it is recommended to use Feishu as the primary interaction end and Web as the viewing end
2. **Avoid concurrency**: do not send messages on both sides at the same time; wait for one side to finish before switching
3. **Check regularly**: use `/mirror` to view the current lock status and queued messages
4. **Timeout setting**: for long tasks, use `/mirror --timeout 15` to set a longer timeout
5. **Lock renewal**: when a task is about to time out during execution, use `/renew` to extend the lock's timeout
6. **Manual unlock**: use `/unlock` to force-release a deadlock
7. **Automatic queue handling**: Web-side queued messages are executed automatically after the lock is released; no extra steps are needed

### 🔧 Troubleshooting

**Problem**: Feishu conversations are not visible in Web

**Solution**:
1. Confirm that the `/mirror` command was run
2. Check whether the session ID matches
3. Confirm that DSH Web uses the same workspace

**Problem**: "会话被占用" keeps showing

**Solution**:
1. Check whether Feishu has unfinished tasks
2. Use `/stop` to stop the current task
3. Wait 5 minutes for the lock to time out and be released automatically
4. Or use `/unlock` to release the lock manually

**Problem**: Web messages keep queueing

**Solution**:
1. Confirm that the Feishu side has finished the current task
2. Check whether another process holds the lock
3. Use `/unlock` to release the lock and process the queue
4. Messages in the queue are **executed automatically** after the lock is released; no need to resend them manually

---

## Future Enhancements

Possible improvement directions:

- [ ] **Web UI lock status indicator**: show a lock status icon and hint in the DSH Web interface (requires modifying the DSH Web source code)
- [ ] Support simultaneous multi-end viewing (true read-only mode)
- [ ] PDF export support (requires an additional PDF generation library)
- [ ] Queue priority (important messages processed first)
- [ ] Custom lock renewal duration (`/renew --timeout 15`)
- [ ] Automatically clean up expired export files

> **Note**: the Web UI lock status indicator requires modifying the DSH Web source code (located in the `@deepseek-ai/dsh` project), which is out of scope for the current `dsh_feishu` project.

---

## Example Conversation

### Feishu Side

```
User: /mirror
Bot: ✅ Web 镜像会话已创建：connect-xxx
     在 DSH Web 中打开此会话即可查看飞书对话历史。

User: 帮我分析项目结构
Bot: 🔄 正在处理任务...
     [Agent 执行中...]
     ✅ 完成
```

### Web Side (Viewing Simultaneously)

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

## Related Documentation

- [Binding Store](../packages/connect/src/binding.ts) - session binding storage
- [Runner](../packages/connect/src/runner.ts) - session driving and locking logic
- [Commands](../packages/connect/src/commands.ts) - command parsing
