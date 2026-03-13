# Options Trading Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 options-trading 系统中已确认的 bug，提升稳定性和正确性。

**Architecture:** options-trading 是运行在 nanoclaw 容器内的 Python 项目，通过 cli.py 调用各 Agent。bug 分布在 data/db.py、agents/cho.py、agents/reviewer.py、agents/cfo.py 等核心文件中。

**Tech Stack:** Python 3.11+, SQLite (WAL), Anthropic SDK, Typer CLI

**Working directory:** `/workspace/group/options-trading`（容器内路径）

---

## Chunk 1: 数据层 Bug 修复

### Task 1: 修复 `db.py` 宏观缓存时区不一致

**Files:**
- Modify: `data/db.py:342`

**问题描述：**
`set_macro_context()` 用 `datetime.utcnow().isoformat()` 写入时间戳，但 `get_macro_context()` 用 `datetime.now(timezone.utc)` 读取并比较。`utcnow()` 返回 naive datetime（无时区），`now(timezone.utc)` 返回 aware datetime（有时区）。虽然 `get_macro_context()` 有 `if updated.tzinfo is None: updated = updated.replace(tzinfo=timezone.utc)` 补救，但 `utcnow()` 在 Python 3.12+ 已被废弃，应统一用 `datetime.now(timezone.utc).isoformat()`。

- [ ] **Step 1: 确认问题代码**

  读取 `data/db.py` 第 339-343 行，确认 `set_macro_context` 用的是 `datetime.utcnow()`

- [ ] **Step 2: 修改代码**

  将 `data/db.py` 第 342 行：
  ```python
  set_setting("macro_context_updated_at", datetime.utcnow().isoformat())
  ```
  改为：
  ```python
  from datetime import timezone
  set_setting("macro_context_updated_at", datetime.now(timezone.utc).isoformat())
  ```

- [ ] **Step 3: 验证修改正确**

  运行：`python3.11 -c "from data.db import set_macro_context, get_macro_context; set_macro_context({'risk_level':'medium'}); print(get_macro_context(ttl_hours=4))"`
  Expected: 返回 `{'risk_level': 'medium'}` 而不是 `None`

- [ ] **Step 4: Commit**

  ```bash
  git add data/db.py
  git commit -m "fix: 统一宏观缓存时间戳使用 datetime.now(timezone.utc)"
  ```

---

### Task 2: 修复 `cfo.py` 除零 bug

**Files:**
- Modify: `agents/cfo.py:66`

**问题描述：**
`breakdown_summary` 列表推导中计算占比时：
```python
"占比%": round(r["cost_usd"] / this_week["total_cost_usd"] * 100, 1)
          if this_week["total_cost_usd"] > 0 else 0,
```
这行有 `if ... else 0` 保护，**不是 bug**。实际的潜在问题是 `last_week_rows` 查询传参时直接用了位置参数但没传参数列表（`query(...,)` 末尾有逗号），需确认实际调用是否正确。

- [ ] **Step 1: 确认 `cfo.py` 第 31-40 行查询调用**

  读取 `agents/cfo.py`，确认 `query(sql,)` 末尾逗号是否导致参数传入问题

- [ ] **Step 2: 如有问题则修复**

  `query()` 函数签名是 `query(sql: str, params: list = None)`，调用 `query(sql,)` 等同于 `query(sql)` — Python 中尾随逗号在函数调用中合法，params 使用默认 None。**无 bug**，跳过。

---

## Chunk 2: Agent 层 Bug 修复

### Task 3: 修复 `cho.py` max_tokens 不足

**Files:**
- Modify: `agents/cho.py:14`

**问题描述：**
`CHOAgent.max_tokens = 1024` 对月度绩效报告严重不足。月度评估需要输出：各角色评分（5-8个角色）、本月之星、宏观/基本面方向准确率、优化建议、改进方向等，1024 tokens 极易截断导致 JSON 解析失败。应改为 3000。

- [ ] **Step 1: 修改 max_tokens**

  将 `agents/cho.py` 第 14 行：
  ```python
  max_tokens: int = 1024
  ```
  改为：
  ```python
  max_tokens: int = 3000
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add agents/cho.py
  git commit -m "fix: 增大 CHO max_tokens 至 3000，防止月度报告 JSON 截断"
  ```

---

### Task 4: 修复 `reviewer.py` lessons 字段类型安全

**Files:**
- Modify: `agents/reviewer.py:116`

**问题描述：**
第 116 行：
```python
"lessons": json.dumps(result.get("强化项", []) + result.get("改进项", []), ensure_ascii=False),
```
若 LLM 返回 `{"强化项": "字符串而非列表", ...}`，`+ ` 操作会触发 TypeError（str + list 不合法）。需要类型保护。

- [ ] **Step 1: 确认问题代码**

  读取 `agents/reviewer.py` 第 112-118 行

- [ ] **Step 2: 修改代码**

  将第 116 行改为：
  ```python
  reinforcements = result.get("强化项", [])
  improvements = result.get("改进项", [])
  if not isinstance(reinforcements, list): reinforcements = []
  if not isinstance(improvements, list): improvements = []
  "lessons": json.dumps(reinforcements + improvements, ensure_ascii=False),
  ```

  完整修改：
  ```python
  # ── 存入 trade_reviews 表 ──────────────────────────
  _reinforcements = result.get("强化项", [])
  _improvements = result.get("改进项", [])
  if not isinstance(_reinforcements, list):
      _reinforcements = []
  if not isinstance(_improvements, list):
      _improvements = []
  review_id = insert("trade_reviews", {
      "position_id": position_id,
      "analysis": json.dumps(result, ensure_ascii=False),
      "lessons": json.dumps(_reinforcements + _improvements, ensure_ascii=False),
      "rule_suggestions": json.dumps(_improvements, ensure_ascii=False),
  })
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add agents/reviewer.py
  git commit -m "fix: reviewer lessons 字段添加列表类型检查，防止 LLM 返回非列表时 TypeError"
  ```

---

### Task 5: 修复 `cho.py` _backtest_outlooks 中 trainer 数据解析安全

**Files:**
- Modify: `agents/cho.py`

**问题描述：**
`_backtest_outlooks()` 中第 278 行：
```python
if "驳回" in (json.loads(r["details"]).get("review", {}).get("审核结论", "") or "")
```
若 `r["details"]` 为 None 或无效 JSON，`json.loads()` 会抛异常。虽然外层有 `except Exception: pass` 但整个 `_rejection_rate` 函数会静默失败，导致症状检测漏报。需要更精细的错误处理。

实际查看代码，`cto.py:_check_quality_symptoms` 中第 272 行有类似问题，但已经有 `except Exception: pass` 保护整个函数，CTO 不会崩溃。**不是严重 bug**。

`_calc_risk_manager_stats` 中第 318 行 `json.loads(rev.get("analysis") or "{}")` 安全（有 `or "{}"` 保护）。

跳过此 Task（已有足够保护）。

---

## Chunk 3: 验证和健康检查

### Task 6: 运行健康检查验证所有修复

**Files:**
- No files modified

- [ ] **Step 1: 运行系统健康检查**

  ```bash
  cd /workspace/group/options-trading && python3.11 cli.py health-check
  ```
  Expected: 所有检查项正常，评分 >= 40

- [ ] **Step 2: 验证宏观缓存修复**

  ```bash
  cd /workspace/group/options-trading && python3.11 -c "
  from data.db import set_macro_context, get_macro_context
  import time
  set_macro_context({'risk_level': 'medium', 'market_bias': 'neutral', 'summary': 'test'})
  time.sleep(1)
  ctx = get_macro_context(ttl_hours=4)
  print('宏观缓存读取:', '成功' if ctx else '失败')
  print('risk_level:', ctx.get('risk_level') if ctx else None)
  "
  ```
  Expected: 输出 `宏观缓存读取: 成功` 和 `risk_level: medium`

- [ ] **Step 3: 验证 CHO 不截断**

  ```bash
  cd /workspace/group/options-trading && python3.11 -c "
  from agents.cho import CHOAgent
  print('CHO max_tokens:', CHOAgent.max_tokens)
  "
  ```
  Expected: 输出 `CHO max_tokens: 3000`

- [ ] **Step 4: 最终 Commit 汇总**

  ```bash
  git log --oneline -5
  ```
  Expected: 看到 Task 1、3、4 的 commit
