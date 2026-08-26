# 自动镜像功能更新

## 🎉 重要更新：全自动镜像

**之前**：需要手动执行 `/mirror` 命令创建 Web 镜像  
**现在**：只要有飞书对话，就**自动创建** Web 镜像 ✨

## 工作原理

### 自动触发时机

1. **新会话创建时**
   - 用户在飞书发送第一条消息
   - `ensureAgent()` 创建新 session
   - 自动调用 `autoCreateWebMirror()`
   - 设置 `webMirrorSessionId = sessionId`

2. **恢复已有会话时**
   - 用户继续之前的对话
   - `ensureAgent()` 恢复 session
   - 检查并确保镜像存在
   - 如果缺失则自动创建

### 代码位置

**修改文件**: `packages/connect/src/runner.ts`

**新增方法**:
```typescript
private autoCreateWebMirror(sessionId: string, ownerKey: string): void {
  // 检查配置是否启用
  if (!this.config.autoMirror) return;
  
  // 仅对飞书频道生效
  if (this.channel !== "feishu") return;
  
  // 检查是否已存在镜像
  if (binding.webMirrorSessionId !== undefined) return;
  
  // 自动创建镜像
  this.bindings.put({
    ...binding,
    webMirrorSessionId: sessionId,
    lockOwner: "feishu",
    lockAcquiredAt: Date.now(),
    lockTimeoutMs: 5 * 60 * 1000,
  });
}
```

**调用位置**:
- `ensureAgent()` - 创建新会话后（第 423 行）
- `ensureAgent()` - 恢复会话后（第 403 行）

## 配置选项

### 默认行为

自动镜像**默认启用**，无需任何配置。

### 禁用自动镜像

如需关闭此功能，在 DSH profile 配置中设置：

```yaml
plugins:
  dsh-connect:
    autoMirror: false  # 禁用自动镜像
```

### 配置类型定义

```typescript
export interface ConnectConfig {
  // ... 其他配置
  /** Automatically create Web mirror for new sessions (default: true). */
  autoMirror?: boolean;
}
```

## 用户体验变化

### Before（之前）

```
用户: 你好
Bot: [处理中...]
用户: /mirror  ← 必须手动执行
Bot: ✅ Web 镜像会话已创建：connect-xxx
用户: [打开 Web GUI 查看]
```

### After（现在）

```
用户: 你好
Bot: [处理中...]
      ↓ 自动创建镜像
用户: [直接打开 Web GUI 查看] ✨
```

## 向后兼容性

✅ **完全兼容**：
- `/mirror` 命令仍然可用（用于查看状态）
- 现有的手动镜像逻辑保持不变
- BindingStore 数据结构无破坏性变更
- 旧的 bindings.json 文件正常加载

## 技术细节

### 为什么在 ensureAgent() 中实现？

1. **统一入口**：所有会话创建/恢复都经过此方法
2. **早期绑定**：在会话使用前就设置好镜像
3. **避免重复**：检查 `webMirrorSessionId` 防止重复创建
4. **配置可控**：通过 `this.config.autoMirror` 控制

### 锁机制

自动创建的镜像默认设置：
- `lockOwner: "feishu"` - 飞书拥有初始锁
- `lockTimeoutMs: 300000` - 5 分钟超时
- `lockAcquiredAt: Date.now()` - 当前时间戳

这确保：
- 飞书可以继续执行任务
- Web 端可以查看但需等待锁释放才能发送
- 超时后自动释放，避免死锁

## 测试验证

### 手动测试步骤

1. 启动 DSH（带 dsh-connect 插件）
2. 在飞书中发送任意消息
3. 检查 `.dsh-connect/bindings.json`：
   ```json
   {
     "channel": "feishu",
     "chatKey": "...",
     "sessionId": "connect-xxx",
     "webMirrorSessionId": "connect-xxx",  ← 应自动出现
     "lockOwner": "feishu",
     ...
   }
   ```
4. 打开 Web GUI，确认会话可见

### 日志验证

查看 DSH 日志，应看到：
```
connect: auto-created Web mirror for session connect-xxx
```

## 常见问题

**Q: 自动镜像会增加性能开销吗？**  
A: 不会。只是在创建/恢复会话时多一次 BindingStore 写入操作，开销可忽略。

**Q: 如果我不想让某些对话被镜像怎么办？**  
A: 设置 `autoMirror: false` 禁用全局自动镜像，然后对需要的对话手动执行 `/mirror`。

**Q: 自动镜像和手动 `/mirror` 会冲突吗？**  
A: 不会。`autoCreateWebMirror()` 会检查 `webMirrorSessionId` 是否已存在，避免重复创建。

**Q: Web GUI 需要安装 connect-web 插件吗？**  
A: 不需要。自动镜像功能内置于 dsh-connect。`connect-web` 插件提供增强的监控功能，但不是必需的。

## 相关文件

- `packages/connect/src/runner.ts` - 核心实现
- `docs/WEB_MIRROR_IMPLEMENTATION.zh.md` - 完整文档
- `packages/connect-web/README.zh.md` - Web 适配器文档

## 总结

✅ **零配置**：开箱即用，无需手动命令  
✅ **实时同步**：对话开始即可在 Web 查看  
✅ **可控制**：支持配置禁用  
✅ **向后兼容**：不影响现有功能  

现在用户可以无缝地在飞书和 Web 之间切换，体验真正的多端同步！🚀
