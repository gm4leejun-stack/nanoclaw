# M1 Token Threshold Redesign

**Date:** 2026-03-17
**Status:** Implemented (2026-03-17)；长运行容器 Bug 修复 (2026-03-24)
**Scope:** container/agent-runner + src/index.ts

---

## 背景与问题

### 现状缺陷

M1（Inline Compaction）当前触发条件：

```
transcript 文件大小（bytes）> 80KB
```

这导致 202.8K input tokens 的轮次未触发压缩，因为：

- Transcript `.jsonl` 只存对话原文，不含 system prompt、CLAUDE.md、工具定义、skills
- 这些固定内容每轮计入 token，但不写入 transcript 文件
- 实际 token 消耗和文件大小之间没有可靠关系

### 目标

1. M1 触发条件改为基于实际 input token 消耗
2. 引入自适应阈值，根据压缩效果自动调整
3. 将 `/input` 和压缩通知的统计单位从字节改为 token
4. 补全 `/input` 遗漏的 global CLAUDE.md 和 skills 分项

---

## 缓存与压缩的交互

Anthropic 缓存按**内容哈希**存储，不依赖 session ID。新 session 不会导致 CLAUDE.md、工具定义等固定内容的缓存失效。

压缩前后缓存状态：

| 内容 | 压缩后 | 缓存 |
|------|--------|------|
| CLAUDE.md / Tools / Skills | 内容不变 | ✅ 继续命中 |
| 对话历史（旧 turns） | 被丢弃 | ❌ 失效（这正是目的） |
| compact seed（新） | 第 1 轮 cache_creation，第 2 轮起 cache_read | 快速重建 |

**净效益**：压缩前 150K 对话历史 × 0.1 = 15K 等效成本。压缩后 seed 8K × 1.25（首轮）= 10K，第 2 轮起 8K × 0.1 = 0.8K。从第二轮开始大幅降低成本。

---

## 触发逻辑设计

### 双重条件（任一满足即触发）

```
条件 A：totalInputTokens - lastCompactTokens > m1IncrementThreshold
条件 B：totalInputTokens - lastCompactTokens > M1_ABSOLUTE_CEILING
```

**条件 A（主要触发器）**：增量触发。固定开销（CLAUDE.md、tools、skills）在增量中自然消除，只反映对话历史的真实增长。

**条件 B（安全红线）**：同样用增量（而非 totalInputTokens 全局累计值），防止单条超长消息冲破 context 上限。使用增量避免全局累计值在使用一天后永久触发的问题。

> **注意**：`totalInputTokens` 是全局累计值（跨 session 不重置），不能直接用于绝对值比较。所有比较必须以 `lastCompactTokens` 为基准做增量计算。

### 初始参数

| 参数 | 初始值 | 说明 |
|------|--------|------|
| `m1IncrementThreshold` | 60,000 tokens | 自适应，随压缩效果调整 |
| `M1_ABSOLUTE_CEILING` | 150,000 tokens | 固定常量，不自适应 |
| 自适应边界 | [30,000, 120,000] | m1IncrementThreshold 的浮动范围 |

### 阈值选择理由

- **60K 增量阈值**：对话积累 60K token 对应约 210KB 原文本，是"压缩明显有效"的临界点。固定开销（≈20-40K cache_read）在增量中已消除，这 60K 纯为对话历史增长
- **150K 绝对上限**：Claude context window 200K，留 50K 安全边距

---

## 自适应机制

每次压缩成功后，下一轮记录 `postCompactInputTokens`，计算效果：

```
dropRatio = (preCompactTokens - postCompactInputTokens) / preCompactTokens
```

调整规则（按优先级顺序，互斥执行）：

| 优先级 | 条件 | 含义 | 操作 |
|--------|------|------|------|
| 1（最高）| 压缩触发时增量 > 150K | 触发太晚，已接近 context 上限 | threshold = min(current × 0.7, 60K) |
| 2 | dropRatio < 15% | 压缩几乎无效 | threshold × 0.9（下限 30K） |
| 3 | dropRatio > 40% | 压缩效果好 | threshold × 1.1（上限 120K） |
| 4（默认）| 15% ≤ dropRatio ≤ 40% | 效果一般 | 不调整 |

> `dropRatio = (上次压缩前增量 - postCompactInputTokens) / 上次压缩前增量`
> "上次压缩前增量" = 触发压缩时的 `totalInputTokens - lastCompactTokens`（需在压缩时单独记录，新增 `preCompactIncrementTokens` 临时字段或内联计算）

类比 M2 的 `outputMultiplier` 自优化逻辑。

---

## TokenOptState 变更

### 新增字段

| 字段 | 类型 | 用途 |
|------|------|------|
| `m1IncrementThreshold` | number | 自适应增量阈值，初始 60000 |
| `postCompactInputTokens` | number | 压缩后首轮 input token，用于效果评估 |
| `awaitingPostCompactMeasure` | boolean | 标记"等待首轮效果评估"状态 |

### 激活已有字段

| 字段 | 现状 | 改后 |
|------|------|------|
| `lastCompactTokens` | 声明但**从未写值** | 压缩成功时写入 `totalInputTokens + inTokens`（当前轮完整 token，含本轮消耗） |

> **写入时机说明**：`tokenOptState.totalInputTokens += inTokens` 在 `writeOutput()` 之后执行。`lastCompactTokens` 必须记录**含当前轮**的完整累计值，即赋值为 `tokenOptState.totalInputTokens + inTokens`（在累加之前），或在累加之后赋值为 `tokenOptState.totalInputTokens`。实现时选后者更简洁：先累加 totalInputTokens，再写 lastCompactTokens。

### 自适应状态流转

```
压缩触发
  → summaryWasWritten = true
  → lastCompactTokens = totalInputTokens（本轮累加后）
  → awaitingPostCompactMeasure = true
  → saveTokenOptState()

下一轮（新 session 启动）
  → 检查 awaitingPostCompactMeasure = true
  → 正常执行完毕，记录本轮 inTokens
  → postCompactInputTokens = inTokens（本轮单轮值，非累计）
  → 计算 dropRatio，调整 m1IncrementThreshold
  → awaitingPostCompactMeasure = false
  → saveTokenOptState()
```

**边界情况**：
- 若压缩后下一轮又触发压缩（back-to-back）：跳过效果评估，直接清除 `awaitingPostCompactMeasure`，避免数据污染
- 若 `lastCompactTokens = 0`（首次使用）：条件 A 等同于 `totalInputTokens > m1IncrementThreshold`，行为正确

---

## 数据库 Schema 变更

### usage 表新增列

```sql
global_claudemd_size_bytes INTEGER NOT NULL DEFAULT 0,
skills_size_bytes          INTEGER NOT NULL DEFAULT 0
```

### compactStats 数据结构变更

```typescript
// 旧
compactStats?: { transcriptBytes: number; seedBytes: number }

// 新
compactStats?: { preCompactTokens: number; seedTokens: number }
```

---

## /input 命令改版

### 数据来源升级

| 字段 | 旧来源 | 新来源 |
|------|--------|--------|
| transcript token | `bytesToTok(transcriptBytes)`（估算） | DB 新增 `transcript_tokens` 列（实测，每轮写入） |
| seed token | `bytesToTok(seedBytes)`（估算） | `seedTokens`（实测，来自 compactStats） |
| global CLAUDE.md token | ❌ 未统计 | `bytesToTok(global_claudemd_size_bytes)` |
| skills token | ❌ 未统计 | `bytesToTok(skills_size_bytes)` |

> **transcript token 来源说明**：`preCompactTokens` 只在压缩轮次存在。对于普通轮次，transcript token 需要另行记录。方案：container 每轮都调用 `getTranscriptSize()` 并配合 `BYTES_PER_TOKEN` 估算，或新增 DB 列 `transcript_tokens` 每轮写入实测值（由 `totalInputTokens - lastCompactTokens` 近似，不需额外测量）。推荐方案：普通轮次显示 `totalInputTokens - lastCompactTokens - claudemd_tok - global_md_tok - skills_tok` 作为"对话历史+工具+消息"，即当前增量部分。

> **seed_size_bytes 已有 bug**：当前代码用 `String.length`（UTF-16 code units）而非 `Buffer.byteLength` 记录 seed 大小。本次改为 `seedTokens` 实测值后，此 bug 同时修复。

### 新展示格式

```
📥 上次 Input 构成分析
🕐 2026-03-17 20:16:00 CST
🤖 claude-sonnet-4-6

─────────────────
📜 对话历史:      120K (59%)
🌱 压缩摘要 seed:   8K  (4%)   ← 仅压缩后第一轮显示
📋 CLAUDE.md:      15K  (7%)
🌐 Global MD:       5K  (2%)
🛠 Skills:          8K  (4%)
💬 工具+当前消息:  48K (24%)   ← 残差（SDK注入工具定义不可测）
─────────────────
⬆️ Input 合计: 204K
  ├ 新鲜处理:  24K   ← 全价
  ├ 缓存命中: 160K   ← 1/10 价
  └ 缓存写入:  20K   ← 1.25× 价
⬇️ Output: 3.2K
```

说明：
- 分类部分（内容来源视角）合计 = Input 合计 ✓
- 缓存明细（费用视角）三项合计 = Input 合计 ✓
- seed 行仅在 `seedTokens > 0` 时显示

---

## 压缩通知消息变更

```
// 旧
📦 对话历史已自动压缩整理 ✨
🗜️ 50KB → 3.2KB，节省 94%
🚀 下条消息轻装出发～

// 新
📦 对话历史已自动压缩整理 ✨
🗜️ 120K token → 8K token，节省 93%
🚀 下条消息轻装出发～
```

---

## TokenOptState 新增字段汇总

| 字段 | 类型 | 初始值 | 用途 |
|------|------|--------|------|
| `m1IncrementThreshold` | number | 60000 | 自适应增量阈值 |
| `postCompactInputTokens` | number | 0 | 压缩后首轮 input token（单轮值） |
| `awaitingPostCompactMeasure` | boolean | false | 等待首轮效果评估 |
| `lastPreCompactIncrement` | number | 0 | 压缩触发时的增量，用于 dropRatio 分母 |

---

## 受影响文件

| 文件 | 变更内容 |
|------|---------|
| `container/agent-runner/src/index.ts` | M1 触发逻辑、TokenOptState 新字段、自适应逻辑、DB 写入补全 global_claudemd + skills 字节、compactStats 改为 token、seed_size_bytes bug 修复 |
| `src/index.ts` | 压缩通知消息改 token 单位、/input 展示逻辑改版、compactStats 类型更新 |

### /opt 测试模式适配

当前 `/opt` 通过 env var `NANOCLAW_OPT_M1_THRESHOLD` 注入低阈值。改版后阈值来自 `TokenOptState.m1IncrementThreshold`，env var 仍有效作为覆盖：

```typescript
function getM1IncrementThreshold(state: TokenOptState): number {
  return parseInt(process.env.NANOCLAW_OPT_M1_THRESHOLD || '') || state.m1IncrementThreshold || 60_000;
}
```

`/opt` 测试模式改为：将 state 中的 `m1IncrementThreshold` 临时改为低值（`min(当前增量×0.8, 60K)`），测试结束后恢复快照。

---

## 长运行容器 Bug 修复（2026-03-24）

### 问题

长运行容器把所有用户消息放在同一个 `runQuery()` for-await loop 里（IPC polling 把消息 push 进 MessageStream）：

- M1 只在 `runQuery()` 开头检查一次，之后不再重检
- `saveTokenOptState()` 只在 loop 结束（`_close` sentinel）时调用，可能数小时后
- `totalInTokens` 跨所有消息累计，M1 检查时的水印是整个 session 的累计值

结果：1758.5K input 的 session 只触发了一次压缩（第一条消息），后续 1100K+ 增量从未重检。

### 修复内容（commit 6fe7eb9）

| 变更 | 文件位置 |
|------|---------|
| 提取 `buildCompactInstruction(existingSeed)` 为独立函数 | `runQuery` 前 |
| 新增 `preRunTotalInputTokens`、`pendingNextCompact`、`compactInjectedViaIpc` 变量 | `runQuery` 内 `loadTokenOptState()` 后 |
| `pollIpcDuringQuery` 消息注入：`pendingNextCompact=true` 时追加 compactInstruction | IPC polling 函数内 |
| compact extraction 条件增加 `|| compactInjectedViaIpc` | 机制一提取块 |
| 每条消息处理完后立即保存 state + 重检 M1 | `writeOutput()` + DB upsert 之后 |
| after-loop 赋值改为幂等：`= preRunTotalInputTokens + totalInTokens` | loop 结束后 |

### 修复后的 M1 触发时序（长运行容器）

```
消息 N 处理完毕
  → 立即保存 tokenOptState（含 totalInputTokens 更新）
  → 重检 M1：nextIncrement > threshold？
    → 是：pendingNextCompact = true

消息 N+1 到达（IPC polling）
  → pendingNextCompact = true
  → 追加 buildCompactInstruction 到消息末尾
  → pendingNextCompact = false，compactInjectedViaIpc = true

消息 N+1 处理（agent 回复）
  → compact extraction 条件：compactInstruction || compactInjectedViaIpc
  → 提取 compact_summary，写入 seed
  → compactInjectedViaIpc = false
```

---

## 后续独立任务（本次不做）

**固定开销监控（M3 扩展）**

触发时机：M1 上线稳定运行 1 周后启动（需要真实 token 基准数据）

内容：
- 周期性统计 global CLAUDE.md + skills 占总 input 的比例
- 超过 40% 时报警或触发 M3
- 补充 /token 报表的固定开销趋势视图

---

## 不在本次范围内

- 工具定义 token 数测量（SDK 内部，无法获取）
- /token 报表的其他改动（仅压缩通知和 /input）
- WhatsApp / Slack / Discord 等其他 channel
