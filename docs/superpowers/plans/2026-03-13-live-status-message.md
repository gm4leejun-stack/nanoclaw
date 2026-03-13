# Live Status Message Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将投资分析期间发给 Telegram 用户的多条状态消息（每步开始/结束各一条，共12条）合并为一条动态更新的消息，避免信息轰炸。

**Architecture:** IPC 层新增 `live_status` 消息类型，携带 `status_key`；NanoClaw 主机在内存中维护 `(chat_jid, status_key) → telegram_message_id` 的映射；首次出现某 key 时发送新消息并记录 ID，后续同 key 改为 `editMessageText` 原地更新。容器内 notify.py 支持传入 `status_key` 参数，pipeline.py 用同一 key 覆写进度。

**Tech Stack:** TypeScript (grammy editMessageText), Python (notify.py), SQLite 不需要变动（映射存内存即可，进程内 TTL 10 分钟）

---

## 文件变更一览

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/types.ts` | 修改 | Channel 接口新增可选 `editMessage?()` |
| `src/channels/telegram.ts` | 修改 | 实现 `editMessage()`；`sendMessage()` 返回 message_id |
| `src/ipc.ts` | 修改 | 处理 `live_status` 消息类型；维护内存映射；调用 editMessage |
| `groups/telegram_option/options-trading/tools/notify.py` | 修改 | `send_progress()` 新增 `status_key` 参数 |
| `groups/telegram_option/options-trading/agents/pipeline.py` | 修改 | 所有 `_notify()` 调用改用同一 `status_key` |

---

## Chunk 1: NanoClaw 主机层改造

### Task 1: Channel 接口扩展

**Files:**
- Modify: `src/types.ts:82-93`

- [ ] **Step 1: 修改 Channel 接口，新增可选的 editMessage 方法**

```typescript
// src/types.ts — 在 setTyping? 之前插入
editMessage?(jid: string, messageId: number, text: string): Promise<void>;
```

最终接口区块：
```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  editMessage?(jid: string, messageId: number, text: string): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

- [ ] **Step 2: 构建确认无类型错误**

```bash
cd /Users/lijunsheng/nanoclaw && npm run build 2>&1 | head -30
```
Expected: 编译成功（0 errors）

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add optional editMessage to Channel interface"
```

---

### Task 2: Telegram Channel 实现 editMessage

**Files:**
- Modify: `src/channels/telegram.ts:290-318`

- [ ] **Step 1: sendMessage 捕获返回的 message_id**

将 `telegram.ts` 中 `sendMessage()` 方法签名改为返回 `Promise<number | null>`（message_id），**仅当消息不需要分片时**才返回 id（分片消息不适合编辑，返回 null）。

```typescript
// src/channels/telegram.ts — 替换 sendMessage 方法
async sendMessage(jid: string, text: string): Promise<number | null> {
  if (!this.bot) {
    logger.warn('Telegram bot not initialized');
    return null;
  }

  try {
    const numericId = jid.replace(/^tg:/, '');
    const mdText = toMarkdownV2(text);
    const opts = { parse_mode: 'MarkdownV2' as const };

    const MAX_LENGTH = 4096;
    if (mdText.length <= MAX_LENGTH) {
      const sent = await this.bot.api.sendMessage(numericId, mdText, opts);
      logger.info({ jid, length: text.length }, 'Telegram message sent');
      return sent.message_id;
    } else {
      for (let i = 0; i < mdText.length; i += MAX_LENGTH) {
        await this.bot.api.sendMessage(
          numericId,
          mdText.slice(i, i + MAX_LENGTH),
          opts,
        );
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent (split)');
      return null;
    }
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send Telegram message');
    return null;
  }
}
```

> **注意：** Channel 接口中 `sendMessage` 签名为 `Promise<void>`，这里扩展返回类型。TypeScript 中子类型返回 `Promise<number | null>` 兼容 `Promise<void>`（调用者忽略返回值时不报错），**但需要确认编译通过**。若报类型错误，改为在 Telegram 类内部缓存 lastSentMessageId 私有属性即可。

- [ ] **Step 2: 新增 editMessage 方法**

在 `sendMessage` 方法之后插入：

```typescript
async editMessage(jid: string, messageId: number, text: string): Promise<void> {
  if (!this.bot) return;
  try {
    const numericId = jid.replace(/^tg:/, '');
    const mdText = toMarkdownV2(text);
    await this.bot.api.editMessageText(numericId, messageId, mdText, {
      parse_mode: 'MarkdownV2' as const,
    });
    logger.info({ jid, messageId }, 'Telegram message edited');
  } catch (err: any) {
    // 消息已过期或内容相同时 Telegram 返回 400，不视为严重错误
    logger.warn({ jid, messageId, err: err?.message }, 'Failed to edit Telegram message');
  }
}
```

- [ ] **Step 3: 构建确认**

```bash
cd /Users/lijunsheng/nanoclaw && npm run build 2>&1 | head -30
```
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat: implement editMessage on TelegramChannel"
```

---

### Task 3: IPC 层支持 live_status 消息类型

**Files:**
- Modify: `src/ipc.ts:60-115`

live_status IPC 消息格式：
```json
{
  "type": "live_status",
  "chatJid": "tg:-5153499522",
  "text": "⏳ [2/6] 研究员分析 开始...",
  "statusKey": "pipeline_aapl"
}
```

逻辑：
- 首次出现 `(chatJid, statusKey)` → 调用 `sendMessage()`，存储返回的 `messageId`
- 再次出现同一 key → 调用 `editMessage()`

映射存在模块级 Map，TTL 10 分钟自动清理（避免内存泄漏）。

- [ ] **Step 1: 在 ipc.ts 顶部增加内存映射类型和 TTL 清理**

在现有 `import` 语句之后，`watchIpc` 函数之前插入：

```typescript
// 内存映射：(chatJid|statusKey) → { messageId, expiresAt }
// TTL 10 分钟，防止泄漏
const liveStatusMap = new Map<string, { messageId: number; expiresAt: number }>();
const LIVE_STATUS_TTL_MS = 10 * 60 * 1000;

function liveStatusKey(chatJid: string, statusKey: string): string {
  return `${chatJid}|${statusKey}`;
}

function purgeLiveStatusExpired(): void {
  const now = Date.now();
  for (const [k, v] of liveStatusMap.entries()) {
    if (v.expiresAt <= now) liveStatusMap.delete(k);
  }
}
```

- [ ] **Step 2: 在 IPC 处理循环中增加 live_status 分支**

在 `src/ipc.ts` 中，找到处理 `data.type === 'message'` 的 if 块（约第 76 行），在其前面插入 `live_status` 处理分支：

```typescript
// live_status: 动态状态消息（首次发送，后续编辑同一条）
if (data.type === 'live_status' && data.chatJid && data.text && data.statusKey) {
  const targetGroup = registeredGroups[data.chatJid];
  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
    purgeLiveStatusExpired();
    const key = liveStatusKey(data.chatJid, data.statusKey);
    const existing = liveStatusMap.get(key);
    if (existing) {
      // 编辑现有消息
      await deps.editMessage?.(data.chatJid, existing.messageId, data.text);
      // 刷新 TTL
      existing.expiresAt = Date.now() + LIVE_STATUS_TTL_MS;
    } else {
      // 首次：发送新消息并记录 ID
      const messageId = await (deps.sendMessage as (jid: string, text: string) => Promise<number | null>)(
        data.chatJid, data.text
      );
      if (messageId !== null && messageId !== undefined) {
        liveStatusMap.set(key, {
          messageId,
          expiresAt: Date.now() + LIVE_STATUS_TTL_MS,
        });
      }
      logger.info({ chatJid: data.chatJid, key, messageId }, 'Live status message created');
    }
  } else {
    logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized live_status IPC message blocked');
  }
  fs.unlinkSync(filePath);
  continue; // skip to next file
}
```

> **注意：** `deps.sendMessage` 原本是 `(jid, text) => Promise<void>`（Channel 接口类型），但 Telegram 实现返回 `Promise<number | null>`。这里用类型断言绕过。若觉得不干净，可在 `deps` 对象上增加独立的 `sendMessageWithId` 方法，但成本更高，YAGNI。

- [ ] **Step 3: deps 对象需要暴露 editMessage**

查看 `watchIpc` 函数签名（约第 30 行），确认 deps 参数定义，新增 `editMessage?` 字段：

```typescript
// 修改 deps 类型，在 sendMessage 之后添加：
editMessage?: (jid: string, messageId: number, text: string) => Promise<void>;
```

同时在 `src/index.ts` 调用 `watchIpc` 处传入 `editMessage`，找到注册 channel 后的调用点并补全：

```typescript
// src/index.ts 中找到 watchIpc(deps) 调用，添加 editMessage:
editMessage: (jid, messageId, text) => {
  const channel = registry.getChannelForJid(jid);
  return channel?.editMessage?.(jid, messageId, text) ?? Promise.resolve();
},
```

- [ ] **Step 4: 构建确认**

```bash
cd /Users/lijunsheng/nanoclaw && npm run build 2>&1 | head -40
```
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/index.ts
git commit -m "feat: IPC live_status message type with in-memory edit tracking"
```

---

## Chunk 2: 容器内 Python 层改造

### Task 4: notify.py 支持 status_key

**Files:**
- Modify: `groups/telegram_option/options-trading/tools/notify.py`

- [ ] **Step 1: 扩展 send_progress 函数签名和 IPC 消息结构**

```python
def send_progress(chat_id: str, text: str, status_key: str = None) -> None:
    """写 IPC 消息文件，nanoclaw 发出 Telegram 消息。
    status_key: 传入时使用 live_status 类型（动态编辑同一条消息），
                None 时退回旧的 message 类型（每次新发一条）。
    """
    if not chat_id:
        return
    ipc_dir = Path("/workspace/ipc/messages")
    ipc_dir.mkdir(parents=True, exist_ok=True)

    if status_key:
        msg = {
            "type": "live_status",
            "chatJid": chat_id,
            "text": text,
            "statusKey": status_key,
        }
    else:
        msg = {"type": "message", "chatJid": chat_id, "text": text}

    filename = ipc_dir / f"progress-{int(time.time() * 1000)}-{random.randint(1000, 9999)}.json"
    filename.write_text(json.dumps(msg, ensure_ascii=False))
```

- [ ] **Step 2: Commit**

```bash
cd /Users/lijunsheng/nanoclaw
git add groups/telegram_option/options-trading/tools/notify.py
git commit -m "feat: notify.py support status_key for live_status IPC messages"
```

---

### Task 5: pipeline.py 改用单条状态消息

**Files:**
- Modify: `groups/telegram_option/options-trading/agents/pipeline.py:44-50`（_notify 闭包及所有调用处）

现状：每个步骤调用两次 `_notify`（开始 + 结束），共 12 次，生成 12 条独立消息。

目标：所有 _notify 调用共用同一 `status_key`（如 `pipeline_{symbol.lower()}`），每次更新覆盖同一条消息，显示当前步骤状态。

最终用户在 Telegram 看到的消息变化示意（同一条消息原地更新）：
```
⏳ [1/6] 宏观分析...
→ ✅ [1/6] 宏观 ✅  ⏳ [2/6] 研究员...
→ ✅ [1/6] 宏观 ✅  ✅ [2/6] 研究员 ✅  ⏳ [3/6] 基本面...
→ ...（逐步积累）
→ ✅ [1/6] 宏观 ✅  ✅ [2/6] 研究员 ✅  ✅ [3/6] 基本面 ✅  ✅ [4/6] 策略 ✅  ✅ [5/6] 风控 ✅  ✅ [6/6] CIO ✅
```

- [ ] **Step 1: 修改 _notify 闭包，增加 status_key 参数及累积状态逻辑**

将 pipeline.py 中 `_notify` 闭包替换为以下版本（包含累积文本逻辑）：

```python
# pipeline.py 中替换 _notify 定义（第 44-50 行区域）

# 状态追踪：按步骤维护完成状态，用于生成累积显示文本
_step_status: list[str] = []   # 已完成步骤的显示文本
_current_step: str = ""         # 当前进行中步骤
_status_key = f"pipeline_{symbol.lower()}"

def _notify(step_text: str, done: bool = False):
    """
    step_text: 步骤描述，如 "[1/6] 宏观分析"
    done: True 表示该步骤完成，False 表示开始
    """
    nonlocal _current_step
    if not notify_chat:
        return
    try:
        from tools.notify import send_progress
        if done:
            _step_status.append(f"✅ {step_text}")
            _current_step = ""
        else:
            _current_step = f"⏳ {step_text}..."
        # 组合显示文本
        lines = list(_step_status)
        if _current_step:
            lines.append(_current_step)
        display = "\n".join(lines) if lines else step_text
        send_progress(notify_chat, display, status_key=_status_key)
    except Exception:
        pass
```

- [ ] **Step 2: 更新所有 _notify 调用，改用新签名**

将 pipeline.py 中所有 `_notify(f"⏳ [N/6] ... 开始...")` 改为 `_notify("[N/6] ...", done=False)`，
将所有 `_notify(f"✅ [N/6] ... 完成")` 改为 `_notify("[N/6] ...", done=True)`。

完整替换列表：

| 原调用 | 新调用 |
|--------|--------|
| `_notify(f"⏳ [1/6] 宏观分析 开始...")` | `_notify("[1/6] 宏观分析", done=False)` |
| `_notify(f"✅ [1/6] 宏观分析 完成")` | `_notify("[1/6] 宏观分析", done=True)` |
| `_notify("⏳ [2/6] 研究员分析 开始...")` | `_notify("[2/6] 研究员分析", done=False)` |
| `_notify("✅ [2/6] 研究员分析 完成")` | `_notify("[2/6] 研究员分析", done=True)` |
| `_notify("⏳ [3/6] 基本面分析 开始...")` | `_notify("[3/6] 基本面分析", done=False)` |
| `_notify("✅ [3/6] 基本面分析 完成")` | `_notify("[3/6] 基本面分析", done=True)` |
| `_notify("⏳ [4/6] 策略设计 开始...")` | `_notify("[4/6] 策略设计", done=False)` |
| `_notify("✅ [4/6] 策略设计 完成")` | `_notify("[4/6] 策略设计", done=True)` |
| `_notify("⏳ [5/6] 风险审核 开始...")` | `_notify("[5/6] 风险审核", done=False)` |
| `_notify("✅ [5/6] 风险审核 完成")` | `_notify("[5/6] 风险审核", done=True)` |
| `_notify("⏳ [6/6] CIO 备忘录 开始...")` | `_notify("[6/6] CIO 备忘录", done=False)` |
| `_notify("✅ [6/6] CIO 备忘录 完成")` | `_notify("[6/6] CIO 备忘录", done=True)` |

> **注意：** Step 2 并行执行研究员和基本面（2个线程），两者共享同一 `_notify`（闭包捕获 `_step_status`），存在并发写风险。用 threading.Lock 保护：
>
> ```python
> import threading as _threading
> _notify_lock = _threading.Lock()
>
> def _notify(step_text: str, done: bool = False):
>     nonlocal _current_step
>     if not notify_chat:
>         return
>     try:
>         from tools.notify import send_progress
>         with _notify_lock:
>             if done:
>                 _step_status.append(f"✅ {step_text}")
>                 _current_step = ""
>             else:
>                 _current_step = f"⏳ {step_text}..."
>             lines = list(_step_status)
>             if _current_step:
>                 lines.append(_current_step)
>             display = "\n".join(lines) if lines else step_text
>         send_progress(notify_chat, display, status_key=_status_key)
>     except Exception:
>         pass
> ```

- [ ] **Step 3: Commit**

```bash
git add groups/telegram_option/options-trading/agents/pipeline.py
git commit -m "feat: pipeline uses single live status message instead of 12 separate messages"
```

---

## Chunk 3: 集成验证

### Task 6: 端到端冒烟测试

- [ ] **Step 1: 重新构建 NanoClaw**

```bash
cd /Users/lijunsheng/nanoclaw && npm run build
```
Expected: 0 errors

- [ ] **Step 2: 重启 NanoClaw 服务**

```bash
launchctl stop com.nanoclaw && sleep 2 && launchctl start com.nanoclaw
```

- [ ] **Step 3: 确认服务正常启动**

```bash
sleep 3 && launchctl list com.nanoclaw
# 期望 PID 非 0，exit status 为空
tail -20 /Users/lijunsheng/nanoclaw/logs/nanoclaw.log
```

- [ ] **Step 4: 在 Telegram 触发分析**

在 `@xiao_wangcai_bot` 对应的 telegram_option 群组发送：
```
/analyze AAPL
```
或按项目实际触发命令。

观察：
- Telegram 中应出现 **1条** 状态消息
- 该消息内容随分析进展逐步更新（从 `⏳ [1/6]...` 到 `✅[1/6]...✅[2/6]...`）
- 分析完成后，最终状态消息显示全部 6 步完成
- 随后正常输出分析报告消息

- [ ] **Step 5: 若 editMessageText 因消息过老失败（Telegram 限制 48h 内才可编辑），检查日志**

```bash
tail -50 /Users/lijunsheng/nanoclaw/logs/nanoclaw.log | grep -E "edit|live_status"
```

warn 日志属正常（已在 editMessage 中降级处理），不应有 error。

---

## 已知限制与边界情况

| 场景 | 处理方式 |
|------|---------|
| 并行步骤（研究员+基本面同时运行）| threading.Lock 保护 `_step_status` 写入 |
| 消息 > 4096 字符（状态文本不会超过）| 正常路径，状态文本不超过 200 字符 |
| editMessageText 失败（过期/内容相同）| warn 日志，降级静默（不再发新消息）|
| liveStatusMap 内存泄漏 | TTL 10 分钟 + purgeLiveStatusExpired 定期清理 |
| 多 symbol 并发分析 | status_key 含 symbol（如 `pipeline_aapl`），互不干扰 |
| Channel 非 Telegram（无 editMessage） | `deps.editMessage?.()` 可选调用，无 editMessage 时静默跳过 |
