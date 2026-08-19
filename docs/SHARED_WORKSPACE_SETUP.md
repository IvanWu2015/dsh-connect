# Shared Workspace Setup Guide

English | [中文](SHARED_WORKSPACE_SETUP.zh.md)

## 🎯 Goal

Make sure Feishu and DSH Web see **exactly the same workspace, session history, and files**.

## ✨ Automation (No Manual Configuration Needed)

**The connect plugin automatically handles all workspace/session associations — no manual configuration is required**:

1. **Automatic workspace registration**: when connect first receives a message, the working directory is automatically registered with the DSH `workspaceRegistry`, and the Web GUI displays the workspace immediately
2. **Automatic session association**: every session created by Feishu (`connect-*`) is automatically attached to its workspace, and the Web GUI sees **exactly the same session list** as Feishu
3. **Historical session backfill**: on startup, sessions already recorded in the bindings are automatically backfilled into the workspace, so old sessions also appear in the Web GUI
4. **Zero configuration**: no need to run `/mirror`, add workspaces manually, or set environment variables

> You only need to **make sure Feishu and DSH Web run in the same DSH process/configuration** (i.e. the connect plugin is loaded into DSH's web profile via `cordis.patch.yml` — the current deployment is already set up this way); everything else is automatic.

---

## 📋 Manual Configuration (Optional, Only When You Need to Override Defaults)

### 1️⃣ Creating the Shared Config File

Create `dsh.shared.config.json` in the project root:

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

### 2️⃣ Configuring Feishu Connect

Feishu's `ConnectService` automatically reads `dsh.shared.config.json`.

Make sure your startup code:

```typescript
import { ConnectService } from "@deepseek-ai/dsh-connect";

// No need to specify workDir manually; it is read from the shared config
const connect = new ConnectService(ctx, {
  // other config...
});
```

### 3️⃣ Configuring DSH Web

DSH Web needs to point to the **same working directory and state directory**.

#### Method A: Environment Variables (Recommended)

Set the following when starting DSH Web:

```bash
# Windows PowerShell
$env:DSH_WORK_DIR="D:\ACOINFO\code\dsh_feishu"
$env:DSH_STATE_DIR=".dsh-connect"
pnpm run dev:web

# Or in the .env file
DSH_WORK_DIR=D:\ACOINFO\code\dsh_feishu
DSH_STATE_DIR=.dsh-connect
```

#### Method B: Via the DSH Config File

In the DSH Web config file (usually `dsh.config.ts` or similar):

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

### 4️⃣ Verifying the Configuration

#### Checking the Feishu Side

Send this in Feishu:

```
/status
```

You should see:

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

#### Checking the Web Side

1. Open DSH Web (http://127.0.0.1:3080)
2. Check whether the working directory shows as `D:\ACOINFO\code\dsh_feishu`
3. Check the session list — you should see the sessions created by Feishu

#### Checking the File System

In the working directory you should see:

```
D:\ACOINFO\code\dsh_feishu\
├── .dsh-connect\
│   ├── bindings.json          # session binding information (shared)
│   └── ...
├── .dsh\
│   └── sessions\              # session history (shared)
│       ├── connect-xxx\
│       │   ├── events.jsonl
│       │   └── ...
│       └── ...
├── dsh.shared.config.json     # shared config file
└── ...
```

---

## 🔍 Key File Descriptions

### `bindings.json`

Location: `.dsh-connect/bindings.json`

This is the **core file shared by Feishu and Web**, containing:

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

**Key fields**:
- `sessionId`: Feishu and Web find the same session via this ID
- `workDir`: ensures both sides use the same working directory
- `webMirrorSessionId`: marks that this session has been mirrored to Web

### `events.jsonl`

Location: `.dsh/sessions/connect-xxx/events.jsonl`

This is the **complete session history record**, containing all user messages, assistant replies, task events, etc.

Feishu and Web **both read this file**, so they see exactly the same history.

---

## ⚠️ Common Issues

### Q1: Feishu and Web see different working directories?

**Cause**: DSH Web is not configured with the correct working directory.

**Solution**:
1. Check DSH Web's environment variables or config file
2. Make sure `DSH_WORK_DIR` or `workspace.defaultPath` matches Feishu's
3. Restart DSH Web

### Q2: Web cannot see Feishu's sessions?

**Cause**: `bindings.json` is not being read by Web.

**Solution**:
1. Make sure Feishu and Web use the same `stateDir` (default `.dsh-connect`)
2. Check whether `.dsh-connect/bindings.json` exists
3. Make sure the `webMirrorSessionId` field is set

### Q3: Files created in Feishu are not visible in Web?

**Cause**: Different working directories.

**Solution**:
1. Make sure both sides' `workDir` are exactly the same (including case and path separators)
2. Use absolute paths to avoid differences caused by relative paths
3. Check file system permissions

### Q4: Session history is out of sync?

**Cause**: The DSH session files are not shared.

**Solution**:
1. Make sure Feishu and Web use the same `sessionStorePath`
2. Check whether the `.dsh/sessions/` directory exists and is readable/writable
3. Make sure no multiple independent DSH instances are running

---

## 🧪 Test Procedure

### Test 1: Working Directory Consistency

1. Send `/status` in Feishu
2. Note the displayed working directory
3. Check the working directory setting in DSH Web
4. The two should be exactly the same

### Test 2: Session Sync

1. Send `/mirror` in Feishu
2. Note the displayed session ID
3. Look up that session ID in DSH Web
4. You should see the same session

### Test 3: File Visibility

1. Have the Agent create a file in Feishu:
   ```
   请在当前工作目录创建一个 test.txt 文件，内容为 "Hello from Feishu"
   ```
2. Look for `test.txt` in the DSH Web file browser
3. You should be able to see the file and view its contents

### Test 4: History Consistency

1. Have a few rounds of conversation in Feishu
2. Open the same session in DSH Web
3. You should see exactly the same conversation history

---

## 📝 Best Practices

1. **Use absolute paths**: avoid inconsistencies caused by relative paths
2. **Unified config source**: all channels read configuration from `dsh.shared.config.json`
3. **Check regularly**: use the `/status` command to verify the working directory is correct
4. **Back up configs**: regularly back up `dsh.shared.config.json` and `bindings.json`
5. **Version control**: add `dsh.shared.config.json` to Git (but not `.dsh-connect/` or `.dsh/`)

---

## 🔗 Related Documentation

- [Web Mirror Session](./MIRROR_SESSION.md) - the mirror mechanism between Feishu and Web
- [Enhancements Summary](./ENHANCEMENTS_SUMMARY.md) - all implemented features
- [Binding Store API](../packages/connect/src/binding.ts) - technical details of session binding

---

**Updated**: 2024-01-15  
**Version**: v0.5.1
