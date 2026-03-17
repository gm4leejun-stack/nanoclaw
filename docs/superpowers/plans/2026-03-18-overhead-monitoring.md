# 固定开销监控（M3 扩展）

## Context

M1 上线后（2026-03-17），`global_claudemd_size_bytes` 和 `skills_size_bytes` 已每轮写入 usage DB。
`/input` 命令已能单轮显示这两项占比，但没有趋势监控和超阈值报警。

本任务实现：
1. 每次 agent 运行结束后，检查该 group 近期固定开销占比，超 40% 发报警
2. `/token` 报表新增"固定开销趋势"一节

**实现范围：纯 host 端，不修改容器代码。**

---

## 设计

### 固定开销定义

```
固定开销 token = bytesToTok(global_claudemd_size_bytes + skills_size_bytes)
固定开销占比  = 固定开销 token / input_tokens
```

用最近 10 条记录的均值作为基准（排除 global_claudemd=0 的 main group 记录）。

### 报警逻辑

- **触发时机**：`runAgent()` 完成后（与 compact notify 同位置）
- **阈值**：均值 > 40%
- **冷却**：per-group 内存 Map，24 小时内只报一次
- **报警消息**：
  ```
  ⚠️ 固定开销偏高
  近10次均值：42%（阈值 40%）
  建议：/compact 压缩 Global CLAUDE.md 或清理 Skills
  ```

### `/token` 趋势视图

在"优化监控"区块末尾追加：

```
📌 固定开销（Global+Skills）
近7日：03-11 32% · 03-12 35% · 03-17 42% ⚠️
均值 38%  今日最新 42%
```

- 查最近 7 个自然日（按北京时间分桶），每日取 avg
- 仅在有数据的日期显示，数据不足 2 天则不显示此节

---

## 受影响文件

| 文件 | 变更 |
|------|------|
| `src/index.ts` | 新增 `checkOverheadRatio(chatJid)` 函数；在 runAgent 后调用；在 `buildTokenStatsMessage()` 追加趋势节 |

---

## 实现步骤

### Step 1：新增 `checkOverheadRatio()` 函数

在 `src/index.ts` 中，紧接在 `buildInputBreakdownMessage()` 函数之后新增：

```typescript
// ── 固定开销报警冷却 Map ───────────────────────────────────────────────────
const overheadAlertCooldown = new Map<string, number>(); // groupId → last alert ms
const OVERHEAD_ALERT_THRESHOLD = 0.4;
const OVERHEAD_ALERT_COOLDOWN_MS = 24 * 3600 * 1000;
const OVERHEAD_SAMPLE_SIZE = 10;

async function checkOverheadRatio(
  chatJid: string,
  sendFn: (msg: string) => Promise<void>,
): Promise<void> {
  const dbPath = path.join(DATA_DIR, 'shared', 'usage', 'usage.db');
  if (!fs.existsSync(dbPath)) return;

  // 冷却检查
  const last = overheadAlertCooldown.get(chatJid) ?? 0;
  if (Date.now() - last < OVERHEAD_ALERT_COOLDOWN_MS) return;

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT input_tokens, global_claudemd_size_bytes, skills_size_bytes
         FROM usage
         WHERE group_id = ? AND global_claudemd_size_bytes > 0
         ORDER BY id DESC LIMIT ?`,
      )
      .all(chatJid, OVERHEAD_SAMPLE_SIZE) as Array<Record<string, number>>;

    if (rows.length < 3) return; // 数据太少，不报警

    const BYTES_PER_TOKEN = 3.5;
    const avg =
      rows.reduce((sum, r) => {
        const fixedTok = Math.round(
          (r['global_claudemd_size_bytes'] + r['skills_size_bytes']) / BYTES_PER_TOKEN,
        );
        return sum + fixedTok / Math.max(r['input_tokens'], 1);
      }, 0) / rows.length;

    if (avg > OVERHEAD_ALERT_THRESHOLD) {
      overheadAlertCooldown.set(chatJid, Date.now());
      const pct = Math.round(avg * 100);
      await sendFn(
        `⚠️ 固定开销偏高\n近${rows.length}次均值：${pct}%（阈值 40%）\n建议：精简 Global CLAUDE.md 或清理 Skills`,
      );
    }
  } finally {
    db.close();
  }
}
```

### Step 2：在 runAgent 后调用

在 `src/index.ts` 中，compact notify 发送完毕之后，追加调用：

```typescript
// 固定开销监控
const ch = findChannel(channels, chatJid);
if (ch) {
  checkOverheadRatio(chatJid, (msg) => ch.sendMessage(chatJid, msg)).catch(
    (err) => log(`overhead check error: ${err}`),
  );
}
```

### Step 3：在 `buildTokenStatsMessage()` 追加趋势节

在 `lines.push('M3 系统 ...')` 之后追加：

```typescript
// ── 固定开销趋势（近7日） ────────────────────────────────────────────────
const CST_OFFSET_MS = 8 * 3600 * 1000;
const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

type OverheadRow = { day: string; ratio: number; cnt: number };
const overheadRows = (
  db
    .prepare(
      `SELECT
         DATE(DATETIME(ts, '+8 hours')) as day,
         AVG(CAST(global_claudemd_size_bytes + skills_size_bytes AS REAL) / NULLIF(input_tokens * 3.5, 0)) as ratio,
         COUNT(*) as cnt
       FROM usage
       WHERE ts >= ? AND global_claudemd_size_bytes > 0
       GROUP BY day
       ORDER BY day DESC
       LIMIT 7`,
    )
    .all(sevenDaysAgo) as unknown[]
).map((r) => {
  const row = r as Record<string, unknown>;
  return {
    day: String(row['day'] ?? ''),
    ratio: typeof row['ratio'] === 'number' ? row['ratio'] : 0,
    cnt: typeof row['cnt'] === 'number' ? row['cnt'] : 0,
  } as OverheadRow;
}).reverse(); // 时间正序

if (overheadRows.length >= 2) {
  const avgRatio = overheadRows.reduce((s, r) => s + r.ratio, 0) / overheadRows.length;
  const todayRow = overheadRows[overheadRows.length - 1];
  const parts = overheadRows.map((r) => {
    const d = r.day.slice(5); // MM-DD
    const p = Math.round(r.ratio * 100);
    return `${d} ${p}%${p > 40 ? ' ⚠️' : ''}`;
  });
  lines.push(`\n**📌 固定开销（Global+Skills）**`);
  lines.push(parts.join(' · '));
  lines.push(
    `均值 ${Math.round(avgRatio * 100)}%  今日最新 ${Math.round(todayRow.ratio * 100)}%`,
  );
}
```

---

## 验证

1. **单元验证（代码层）**：
   ```bash
   npm run build   # 确认 TypeScript 编译通过
   ```

2. **功能验证**：
   - 发送任意消息触发 agent，完成后查日志确认 `overhead check` 无报错
   - 发送 `/token` 确认出现"固定开销（Global+Skills）"趋势节（需至少 2 天数据）
   - 手动测试报警：将 `OVERHEAD_ALERT_THRESHOLD` 临时改为 `0.01`，触发一次 agent，确认收到报警消息，再改回

3. **服务重启**：
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
