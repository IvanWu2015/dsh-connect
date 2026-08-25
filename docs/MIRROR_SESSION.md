# Web Mirror Session - Syncing Feishu Conversations to DSH Web

English | [中文](MIRROR_SESSION.zh.md)

## Overview

Mirror each Feishu chat's DSH session into the DSH Web GUI so the conversation history can be **viewed across platforms**. The Feishu channel and the Web GUI share the **same DSH session** — the same session ID and the same history.

### 🎯 Core Goals

- **Same workspace**: Feishu and Web see the same file system and directory structure
- **Same session**: through a shared session ID and history, both sides see exactly the same conversation
- **Honest access model**: the lock arbitrates the Feishu side only — the Web GUI is always writable (see [The Lock Is One-Sided](#-the-lock-is-one-sided-important) below)

### ⚡ Automatic Sync

**The connect plugin automatically syncs the workspace and sessions — no manual steps are required**:

1. **Automatic workspace registration**: after connect starts, the working directory is automatically registered with the DSH `workspaceRegistry`, and the Web GUI displays the workspace immediately
2. **Automatic session association**: every session created by Feishu is automatically attached to its workspace, and the Web GUI shows exactly the same session list as Feishu
3. **Historical session backfill**: on startup, sessions already present in the bindings are automatically backfilled into the workspace, so old sessions also appear in the Web GUI
4. **Automatic mirror (`autoMirror`)**: `autoMirror` defaults to `true`, so every new Feishu chat automatically gets its mirror session — you usually do not need to run `/mirror` at all

> 💡 **No manual configuration needed**: as long as the Feishu connect and DSH Web run in the same DSH process (loaded via `cordis.patch.yml`), the workspace and sessions stay consistent automatically. See [Shared Workspace Setup](./SHARED_WORKSPACE_SETUP.md).

### 🔑 Commands (v0.6.2)

| Command | Purpose |
|---|---|
| `/mirror [--timeout N]` | Create (or show the status of) the Web mirror session for this chat; optional lock timeout in minutes |
| `/unlock` | Manually release the session lock |
| `/renew` | Extend the current lock's timeout by a full period (only the lock owner can renew) |
| `/export [markdown]` | Export the conversation history as Markdown |

---

## How the Mirror Works

The mirror is **bookkeeping on the shared binding**: when a chat is mirrored, its `ChatBinding` carries `webMirrorSessionId` (the session the Web GUI opens) and `lockOwner`. The DSH Web GUI reads sessions directly from DSH's session store, so the mirrored conversation simply appears in the GUI under the shared workspace.

### 🔒 The Lock Is One-Sided (Important)

`lockOwner` (`"feishu" | "web"`) is enforced **only by the Feishu-side `AgentRunner`**:

- The Feishu runner checks / acquires / releases the lock around each task turn.
- **DSH Web never goes through the connect-web adapter and never queries the lock**: the Web GUI reads and writes DSH sessions directly (through DSH's own api-proxy). In practice the Web side is **always writable**.
- Consequence: the lock can serialize Feishu-side turns and record who "owns" the session, but it **cannot** stop a Web user from writing into the same session at the same time. This is an architectural limitation of the current DSH Web GUI and **cannot be fixed from this repository** — do not assume the Web side obeys the mutex.

### 🔒 Lock Scope

- The lock exists only for the **feishu / web** channels of the **same mirrored session**. **Telegram and DingTalk never participate** in the lock — `lockOwner` is only ever `"feishu" | "web"`.

### 🔄 Lock Lifecycle

- **Acquired** when a Feishu turn starts; **released** when the turn finishes (success or error).
- **Timeout auto-release**: a lock held without activity past its timeout is released automatically — default **5 minutes**; adjust with `/mirror --timeout N` at creation or `/renew` while running.
- **Manual release**: `/unlock` releases the lock immediately.
- **Renewal**: `/renew` extends the lock by a full timeout period from now.
- **Session changes**: `/new`, `/clear` and switching to another session (`/chat`) clear `webMirrorSessionId` / `lockOwner`; `autoMirror` then re-creates the mirror for the newly active session.

---

## Usage

### 1️⃣ Creating a Web Mirror Session

Send this in Feishu:

```
/mirror
```

Or (alias):

```
/web
```

**Expected output**:

```
✅ Web 镜像会话已创建：connect-c38f92c6-2d6b-450c-95c1-c2aad995aff0
在 DSH Web 中打开此会话即可查看飞书对话历史。
```

> With `autoMirror: true` (default) this command is usually unnecessary — the mirror already exists once the first message creates the session.

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

## Access Control Logic (honest walk-through)

### Scenario 1: A Feishu turn is running

```
飞书用户："帮我分析这个文件"
→ Feishu runner acquires the lock（锁定方 = 飞书，超时计时开始）
→ Meanwhile a Web user sends a message into the same session
→ The Web GUI writes it directly into the shared DSH session（它从不查询锁）
→ Both writes land in the same session; the lock cannot stop the Web write
```

### Scenario 2: Turn complete, lock released

```
飞书任务完成（或出错）
→ 自动释放锁（锁定方 = undefined）
→ 飞书侧下一条任务消息可以重新获取锁
```

### Scenario 3: Timeout auto-release

```
飞书获得锁后 5 分钟无活动
→ 自动检测超时
→ 释放锁并通知："⏰ 会话锁已超时（5 分钟无活动），自动释放"
→ 飞书侧可以重新获取锁
```

### Scenario 4: Manual unlock

```
飞书侧发送 /unlock
→ 检查是否有活跃锁
→ 释放锁
→ 通知："🔓 会话锁已手动释放"
```

### Scenario 5: No lock (initial or idle)

```
双方都空闲
→ 飞书侧下一条任务消息会获取锁
→ Web 侧随时可写（它不检查锁）
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

> These helpers run **inside the Feishu-side runner only**; the Web GUI never calls them.

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
2. **One-sided lock**: the lock is enforced only on the Feishu side; **the Web GUI is always writable** and never consults the lock — an architectural limitation of DSH Web that cannot be fixed in this repository
3. **Lock scope**: only the feishu / web channels of mirrored sessions; telegram / dingtalk never participate
4. **Timeout protection**: default 5 minutes without activity (adjustable via `/mirror --timeout N` or `/renew`)
5. **Lock renewal**: `/renew` extends the current lock's timeout

### 💡 Best Practices

1. **Primary interaction end**: use Feishu as the primary interaction end and Web mainly for viewing (because the lock is one-sided, simultaneous writes from both ends can interleave)
2. **Avoid concurrency**: do not send messages on both sides at the same time; wait for one side to finish before switching
3. **Check regularly**: use `/mirror` to view the current lock status
4. **Timeout setting**: for long tasks, use `/mirror --timeout 15` to set a longer timeout
5. **Lock renewal**: when a task is about to time out during execution, use `/renew` to extend the lock's timeout
6. **Manual unlock**: use `/unlock` to force-release a deadlock

### 🔧 Troubleshooting

**Problem**: Feishu conversations are not visible in Web

**Solution**:
1. Confirm that a mirror exists (`/mirror`, or autoMirror)
2. Check whether the session ID matches
3. Confirm that DSH Web uses the same workspace

**Problem**: "会话被占用" keeps showing (Feishu side)

**Solution**:
1. Check whether Feishu has unfinished tasks
2. Use `/stop` to stop the current task
3. Wait for the lock timeout (default 5 minutes)
4. Or use `/unlock` to release the lock manually

---

## Future Enhancements

Possible improvement directions:

- [ ] **Web UI lock status indicator**: show a lock status icon and hint in the DSH Web interface (requires modifying the DSH Web source code)
- [ ] Enforce the lock on the Web side too (requires modifying DSH Web)
- [ ] PDF export support (requires an additional PDF generation library)
- [ ] Custom lock renewal duration (`/renew --timeout 15`)
- [ ] Automatically clean up expired export files

> **Note**: the Web UI lock status indicator and Web-side lock enforcement require modifying the DSH Web source code (located in the `@deepseek-ai/dsh` project), which is out of scope for the current `dsh_feishu` project.

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
