# dsh-connect-web

English | [中文](README.zh.md)

Web channel adapter for `dsh-connect`: enables DSH Web GUI to automatically mirror and interact with Feishu conversations.

## Overview

This package provides a bridge between `dsh-connect`'s mirror sessions and the DSH Web GUI. 

**✨ NEW: Automatic Mirroring** - As of the latest version, Web mirrors are created **automatically** for every Feishu conversation. No manual `/mirror` command needed!

The adapter monitors `BindingStore` for chats with `webMirrorSessionId` set (auto-created by dsh-connect) and makes those sessions available in the Web interface.

## Features

- **Automatic Mirror Detection**: Monitors `BindingStore` for chats with `webMirrorSessionId` set
- **Event-Driven Updates**: Real-time detection of new mirrors through change events
- **Session Lock Awareness**: Respects lock ownership to prevent concurrent write conflicts
- **Message Queuing**: Queues Web messages when Feishu holds the lock, processes them on release
- **Fallback Polling**: Periodic scanning as a safety net if events are missed

## Installation

Add to your DSH profile configuration:

```yaml
plugins:
  connect-web: {}
```

Or with custom options:

```yaml
plugins:
  connect-web:
    pollIntervalMs: 2000  # Poll every 2 seconds instead of default 1s
```

## Usage

### Automatic Mirroring (Default)

**No setup required!** Every Feishu conversation automatically gets a Web mirror:

1. Start chatting with the bot in Feishu
2. Open DSH Web GUI at http://127.0.0.1:3080
3. The conversation appears automatically ✨

The mirror is created when:
- A new session is started
- An existing session is resumed

### Manual Mirror Control (Optional)

The `/mirror` command is still available for viewing status:

```
/mirror
```

This shows:
- Current mirror session ID
- Lock owner and timeout
- Queued message count

### Viewing Mirrors in Web GUI

Once a conversation starts in Feishu:
1. Open DSH Web GUI at http://127.0.0.1:3080
2. The mirrored session appears automatically
3. You can view the full conversation history
4. Send messages (subject to lock ownership)

### Session Locking

To prevent conflicts when both Feishu and Web are active:

- **Lock Owner**: Only the lock owner can send messages that trigger agent execution
- **Read-Only Mode**: Non-owner can view but messages are queued
- **Timeout**: Locks auto-release after 5 minutes of inactivity
- **Manual Release**: Use `/unlock` in Feishu to release the lock early

### Commands

From Feishu:
- `/mirror` - Create or show Web mirror status
- `/unlock` - Manually release the session lock

From Web GUI:
- Messages are automatically queued if lock is held by Feishu
- Queue is processed when lock is released

## Architecture

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

## API Reference

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

### BindingStore Extensions

The `BindingStore` has been extended with:

```typescript
// Subscribe to binding changes
onChange(callback: (binding: ChatBinding, changeType: "add" | "update" | "delete") => void): () => void;

// Iterate over all bindings
entries(): IterableIterator<ChatBinding>;
list(): ChatBinding[];

// Find bindings by webMirrorSessionId
findByWebMirror(sessionId: string): ChatBinding[];
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pollIntervalMs` | number | 1000 | Polling interval for mirror detection (ms) |

## Troubleshooting

### Mirror not appearing in Web GUI

1. Verify `/mirror` was sent successfully in Feishu
2. Check DSH logs for `connect-web: Web adapter registered` message
3. Ensure `dsh-connect` service is loaded before `connect-web`

### Messages not sending from Web

1. Check lock status: is Feishu currently executing a task?
2. Wait for lock timeout (5 minutes) or use `/unlock` in Feishu
3. Verify message appears in queue (check logs)

### High CPU usage

Reduce polling frequency:
```yaml
plugins:
  connect-web:
    pollIntervalMs: 5000  # Poll every 5 seconds
```

## License

MIT
