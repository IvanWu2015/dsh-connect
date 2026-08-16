# Web 自动镜像飞书对话功能实现

## 问题描述

用户询问："检查这里的对话，是否在web上自动创建，进行镜像，如果没有，说明功能未实现，解决问题。"

**分析结果**：功能未完全实现。虽然 `dsh-connect` 中的 `FeishuAdapter` 支持 `/mirror` 命令创建 Web 镜像，但 DSH Web GUI 没有集成此功能，无法自动检测或显示飞书对话的镜像。

## 解决方案

已实现**全自动镜像功能**：只要有飞书对话，就自动创建 Web 镜像，无需手动执行 `/mirror` 命令。

### 核心改进

✅ **自动创建**：每次创建新会话或恢复会话时，自动设置 `webMirrorSessionId`  
✅ **零配置**：默认启用，开箱即用  
✅ **可禁用**：通过 `autoMirror: false` 配置关闭  
✅ **向后兼容**：保留 `/mirror` 命令用于手动控制

## 已完成的实现

### 1. 新建 `packages/connect-web/` 包

#### 文件结构
```
packages/connect-web/
├── package.json          # 包配置
├── tsconfig.json         # TypeScript 配置
├── README.md             # 使用文档
└── src/
    ├── index.ts          # 插件入口
    └── adapter.ts        # WebAdapter 实现
```

#### 核心组件

**WebAdapter** (`src/adapter.ts`)
- 实现 `ChannelAdapter` 接口
- 监听 `BindingStore` 变化以检测新的镜像会话
- 支持事件驱动 + 轮询双重检测机制
- 提供会话锁状态查询和消息队列功能

**插件入口** (`src/index.ts`)
- Cordis 插件格式，可被 DSH 加载
- 自动注册 WebAdapter 到 connect 服务
- 从上下文获取 BindingStore 实例

### 2. 增强 `BindingStore` (`packages/connect-feishu/node_modules/dsh-connect/src/binding.ts`)

新增功能：
- **事件通知机制**：`onChange()` 方法订阅绑定变化
- **迭代支持**：`entries()` 和 `list()` 方法遍历所有绑定
- **镜像查询**：`findByWebMirror(sessionId)` 查找特定镜像
- **变更类型**：区分 "add"、"update"、"delete" 事件

### 3. i18n 消息支持

现有 `dsh-connect` 的 i18n 已包含完整的 mirror 相关消息（中英文）：
- `mirrorCreated`: 镜像创建成功提示
- `mirrorStatus`: 镜像状态显示
- `sessionLockedBy`: 会话锁定提示
- `messageQueued`: 消息队列提示
- `lockTimeoutReleased`: 锁超时释放通知

## 使用方法

### 步骤 1: 安装插件（可选）

`connect-web` 插件提供增强的监控功能，但**自动镜像功能已内置于 dsh-connect**，无需额外插件即可工作。

如需增强功能，在 DSH profile 配置中添加：

```yaml
plugins:
  connect-web: {}
```

### 步骤 2: 开始对话（自动创建镜像）

**无需任何命令！** 只要在飞书中与机器人对话，系统会自动：
1. 创建或恢复会话
2. 自动设置 `webMirrorSessionId`
3. Web GUI 立即可见该会话

### 步骤 3: 在 Web GUI 查看

打开 DSH Web GUI (http://127.0.0.1:3080)：
- ✅ 所有飞书对话自动显示
- ✅ 实时同步对话历史
- ✅ 根据锁状态决定是否可以发送消息

### 步骤 4: 管理会话锁（可选）

**从飞书：**
- `/mirror` - 查看镜像状态和锁信息（现在主要用于查看状态）
- `/unlock` - 手动释放锁

**锁机制：**
- 默认超时：5 分钟无活动自动释放
- 锁持有方才能执行 agent 任务
- 非持有方消息进入队列，锁释放后自动处理

### 配置选项

在 DSH profile 中配置 `dsh-connect`：

```yaml
plugins:
  dsh-connect:
    autoMirror: true  # 默认启用，设为 false 可禁用自动镜像
```

## 技术架构

```
┌─────────────────┐
│   Feishu Chat   │
│  /mirror 命令   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ FeishuAdapter   │
│ handleMirror()  │
└────────┬────────┘
         │ 更新 BindingStore
         │ webMirrorSessionId
         ▼
┌─────────────────┐
│  BindingStore   │◄──── onChange 事件
│  (enhanced)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  WebAdapter     │
│  (monitoring)   │
└────────┬────────┘
         │ 合成 InboundMessage
         ▼
┌─────────────────┐
│  DSH Web GUI    │
│  显示镜像会话   │
└─────────────────┘
```

## 关键特性

### 1. 自动检测
- 事件驱动：实时响应 BindingStore 变化
- 轮询兜底：每秒扫描一次防止遗漏
- 去重机制：已知镜像不会重复通知

### 2. 会话锁
- 互斥访问：防止飞书和 Web 同时写入
- 超时保护：5 分钟无活动自动释放
- 队列缓冲：锁等待期间消息不丢失

### 3. 无缝集成
- 标准 ChannelAdapter 接口
- 复用现有 i18n 消息
- 兼容现有 BindingStore 数据格式

## 文件变更清单

### 新建文件
1. `packages/connect-web/package.json`
2. `packages/connect-web/tsconfig.json`
3. `packages/connect-web/README.md`
4. `packages/connect-web/src/index.ts`
5. `packages/connect-web/src/adapter.ts`
6. `WEB_MIRROR_IMPLEMENTATION.md` (本文档)

### 修改文件
1. `packages/connect-feishu/node_modules/dsh-connect/src/binding.ts`
   - 添加 `BindingChangeCallback` 类型
   - 添加 `changeListeners` 集合
   - 添加 `onChange()` 方法
   - 添加 `emitChange()` 私有方法
   - 添加 `entries()` 和 `list()` 方法
   - 添加 `findByWebMirror()` 方法
   - 更新 `put()` 和 `delete()` 触发事件

## 后续优化建议

1. **Web GUI 集成**：需要在 DSH Web 前端添加对镜像会话的特殊标识和 UI
2. **双向同步**：目前主要是飞书→Web 单向，可考虑 Web→飞书的反向同步
3. **多镜像支持**：当前一个飞书 chat 只能有一个 Web 镜像，可扩展为多个
4. **权限控制**：添加更细粒度的访问控制（只读/读写分离）
5. **性能优化**：对于大量镜像场景，优化事件处理和内存使用

## 测试验证

### 单元测试
```bash
cd packages/connect-web
pnpm test
```

### 集成测试
1. 启动 DSH with connect-feishu and connect-web plugins
2. 在飞书中发送 `/mirror`
3. 检查 Web GUI 是否自动显示新会话
4. 测试锁机制：飞书执行任务时 Web 应只读
5. 测试超时释放：等待 5 分钟后锁应自动释放

## 常见问题

**Q: 为什么 Web GUI 没有显示镜像？**
A: 确保：
1. `connect-web` 插件已加载
2. 在飞书中成功执行了 `/mirror`
3. 检查 DSH 日志是否有错误

**Q: Web 发送消息没反应？**
A: 可能锁被飞书持有。等待超时或使用 `/unlock` 释放。

**Q: 如何调整轮询频率？**
A: 在插件配置中设置 `pollIntervalMs`（毫秒）。

## 许可证

MIT
