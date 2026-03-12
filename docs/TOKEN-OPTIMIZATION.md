# NanoClaw 智能 Token 优化需求文档

> 版本：v1.1
> 日期：2026-03-12

---

## 背景

NanoClaw 每次 API 调用的 token 成本构成（贵→便宜）：

- **Output token**：最贵，约 5 倍于 input 价格
- **对话历史**：最大变量，session 不压缩则无限膨胀
- **Tool Results**：工具调用原始返回，用完即废但持续占位
- **System Prompt / CLAUDE.md**：固定开销，每次都带

目标：在每次对话的处理链路上自动介入，从源头预防浪费。

---

## 核心原则

> **只要是纯计算逻辑（不调 LLM），不管多复杂都做；只要调 LLM，就要严格评估 token 成本。**

---

## 机制一：Inline Compaction

### 解决的问题

对话历史 + Tool Results 无限膨胀。

### 触发逻辑（零 token）

```
每次 API 调用时（runQuery）：
  检查 transcript 文件大小
  如果 > 80KB：
    在本次调用的 system prompt 里注入隐藏压缩指令（<hidden_instruction>）
    Claude 正常回复的同时，顺带输出 <compact_summary>
    从回复中提取摘要，写入 seed 文件（.compact-seed.md）
    对用户不可见（从展示内容中剥离标签）
  下次 session 启动时（新 sessionId）：
    加载 seed 文件作为初始 context，丢弃完整历史
```

**关键**：当轮触发、当轮处理，不等下一次对话。摘要输出是正常回复的附带产物，无额外 API 调用。

### 成本分析

| | 单独 compact 调用 | Inline compaction |
|---|---|---|
| Input | 全量历史（重新传一遍）| 0（历史本来就在 messages 里）|
| Output | 摘要 | 摘要（同样的输出，挪过来了）|
| **净成本** | **全量历史 input + 摘要 output** | **仅摘要 output（本来就要付）** |

### 压缩策略

指令要求 Claude 输出包含以下结构的摘要，已有 seed 时只压缩新增内容并合并：

```xml
<compact_summary>
  <tool_results>
    [最近2轮之前的工具调用结论摘要，格式：工具名→关键结论，原始数据丢弃]
  </tool_results>
  <conversation_summary>
    <completed>[已完成事项]</completed>
    <pending>[待完成/进行中任务]</pending>
    <context>[关键背景、约束、用户偏好]</context>
    <decisions>[重要决策和结论]</decisions>
  </conversation_summary>
</compact_summary>
```


---

## 机制二：响应长度控制

### 解决的问题

Output token 浪费（output 比 input 贵 5 倍）。

### 约束指令

一条通用软约束，不做消息类型分类（分类逻辑脆弱，误判代价高于不分类）：

```
回复时结论优先，能一句话说清的不写三句，细节按需展开，不重复已知信息。
```

### 注入时机（两个条件取「或」）

**条件一：周期保底**
```
距上次注入，新增 context 超过 X token
X = compaction 阈值 ÷ 2（复用 compaction 的 token 计数逻辑，无新增状态）
```

**条件二：漂移修正**
```
满足任一：
  上一轮 output > 近期均值 × 系数（相对漂移）
  上一轮 output > Y token（绝对上限兜底）

初始参数：
  系数 = 1.5
  Y = 700 token（Telegram 场景）
```

**Y 存在的意义**：当 input 很大时，output 合理变长，纯系数无法区分「正常变长」和「指令遗忘漂移」，绝对值兜底解决这个盲点。

### 参数自优化（零 token，纯计算）

```
注入提醒后，记录下一轮 output token 数：

下一轮明显变短 → 阈值合适，不调整
下一轮没变化   → 阈值太松，系数 × 0.9（收紧）
长期无触发     → 阈值太紧，系数 × 1.1（放宽）
```

数据来源：`data/shared/usage/usage.db`，无需新增基础设施。

### 成本

| 状态 | token 成本 |
|------|------------|
| 注入时 | 约 30 token |
| 平均摊薄 | < 3 token / 轮 |
| 不满足条件时 | 0 |

---

## 机制三：CLAUDE.md 动态压缩

### 解决的问题

CLAUDE.md 随 Agent auto-memory 自动写入而持续膨胀，每次对话都带着越来越大的 system prompt。

### 触发逻辑（零 token）

```
每次 API 调用时（runQuery）：
  读取 CLAUDE.md，检查文件大小
  如果 > 10KB：
    在本次调用的 system prompt 里注入隐藏压缩指令（<hidden_instruction>）
    Claude 正常回复的同时，顺带输出 <compressed_claudemd>
    验证通过后原地覆盖写入 CLAUDE.md
    下次调用时文件已缩小，不再触发（直到再次膨胀）
```

与机制一完全相同的 inline 思路，不单独发起额外调用。每次调用都动态检测，文件压缩后自然停止触发。

### 压缩策略

| 内容类型 | 处理方式 |
|----------|----------|
| 规则、禁止项、必须项、格式要求 | **原文保留，不许改动** |
| 背景说明、解释性文字 | 激进压缩或删除 |
| 举例 | 保留最多一个，其余删除 |
| 重复表达 | 删除重复，保留一处 |

**原理**：LLM 不需要知道「为什么」，只需要知道「是什么」。删除解释类内容不只省 token，还可能提升指令遵守率（规则不被大量解释稀释）。

### 验证（零 token，纯字符串匹配）

```
提取原文中包含约束关键词的行：
  「禁止」「必须」「不能」「需要」「不许」「要」等

压缩后逐一检查这些行是否仍然存在：
  全部存在 → 自动应用压缩版本
  有缺失   → 记录日志，等待人工处理（不自动应用）
```

### 成本

- 触发检测：零 token
- 压缩调用：有 token，但 inline 进正常调用，无额外成本
- 结构化验证：零 token
- 人工介入：仅验证失败时

---

## 实现文件

| 文件 | 改动内容 |
|------|----------|
| `container/agent-runner/src/index.ts` | 机制一：compaction 检测、注入、提取；机制二：软约束注入逻辑；机制三：CLAUDE.md 大小检测与压缩注入 |
| `src/container-runner.ts` | 机制一：启动容器时加载 seed 文件作为初始 context |
| `src/index.ts` | 机制二：token 计数状态、自优化参数持久化 |

---

## 验证方式

1. **机制一**：发送多条消息直到 context > 80KB，确认当轮回复含 `<compact_summary>`，确认下轮 session token 用量骤降
2. **机制二**：发送「你好」确认回复简短；发送技术问题确认回复完整；观察 `usage.db` 中 output token 趋势
3. **机制三**：持续对话直到 CLAUDE.md 超阈值，确认自动压缩触发，确认关键词验证通过，确认文件大小下降

全程通过 `data/shared/usage/usage.db` 对比优化前后 input / output token 数据。
