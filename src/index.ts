import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // Fast path: "token用量" — aggregate stats across all groups from shared usage dir
  const lastContent = missedMessages[missedMessages.length - 1].content.trim();
  if (
    lastContent === 'token用量' ||
    lastContent === 'token使用量' ||
    lastContent === 'token消耗'
  ) {
    try {
      const msg = await buildTokenStatsMessage();
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      await channel.sendMessage(chatJid, msg);
      return true;
    } catch (err) {
      logger.warn({ err }, 'Failed to compute token usage stats');
      // Fall through to container agent on error
    }
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  let pendingCompactNotify = false;
  let pendingCompactStats:
    | { transcriptBytes: number; seedBytes: number }
    | undefined;
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        if (output.compacted) {
          // 清除 session，让下条消息从 compact seed 轻装启动
          delete sessions[group.folder];
          deleteSession(group.folder);
          pendingCompactNotify = true;
          pendingCompactStats = output.compactStats;
        }
        await onOutput(output);
      }
    : undefined;

  // 机制一：新 session 时读取 compact seed 文件
  let compactSeed: string | undefined;
  if (!sessionId) {
    const seedPath = path.join(
      resolveGroupFolderPath(group.folder),
      '.compact-seed.md',
    );
    if (fs.existsSync(seedPath)) {
      try {
        compactSeed = fs.readFileSync(seedPath, 'utf-8');
        logger.debug(
          { group: group.name },
          '[token-opt] Loaded compact seed for new session',
        );
      } catch {
        /* ignore */
      }
    }
  }

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        compactSeed,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (pendingCompactNotify) {
      const channel = findChannel(channels, chatJid);
      let compactMsg = '📦 对话历史已自动整理，下条消息将轻装开始新对话～';
      if (pendingCompactStats) {
        const { transcriptBytes, seedBytes } = pendingCompactStats;
        const fromKB = Math.round(transcriptBytes / 1024);
        const toKB = (seedBytes / 1024).toFixed(1);
        const savedPct = Math.round((1 - seedBytes / transcriptBytes) * 100);
        compactMsg = `📦 对话历史已自动压缩整理 ✨\n🗜️ ${fromKB}KB → ${toKB}KB，节省 ${savedPct}%\n🚀 下条消息轻装出发～`;
      }
      await channel?.sendMessage(chatJid, compactMsg);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  parts.push(`${minutes}分钟`);
  return parts.join(' ');
}

const processStartTime = Date.now();

async function buildTokenStatsMessage(): Promise<string> {
  const dbPath = path.join(DATA_DIR, 'shared', 'usage', 'usage.db');
  if (!fs.existsSync(dbPath)) {
    return '📊 暂无用量数据（usage.db 未找到）。';
  }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);

  const now = new Date();
  // 今日起点使用北京时间（UTC+8）
  const CST_OFFSET = 8 * 3600 * 1000;
  const cstNow = new Date(now.getTime() + CST_OFFSET);
  const todayStr = cstNow.toISOString().slice(0, 10); // "YYYY-MM-DD" in CST
  // 转回 UTC ISO 字符串用于 ts >= ? 比较（usage.db 存储 UTC）
  const todayStart = new Date(`${todayStr}T00:00:00+08:00`).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const monthAgo = new Date(
    now.getTime() - 30 * 24 * 3600 * 1000,
  ).toISOString();

  const fmtM = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
  };
  const fmtCost = (usd: number): string => `$${usd.toFixed(3)}`;
  const BYTES_PER_TOKEN = 3.5;

  const getPrice = (model: string | null): { inp: number; out: number } => {
    const m = (model ?? '').toLowerCase();
    if (m.includes('haiku')) return { inp: 0.8, out: 4 };
    if (m.includes('opus')) return { inp: 15, out: 75 };
    return { inp: 3, out: 15 };
  };
  const safe = (v: unknown): number => (typeof v === 'number' ? v : 0);

  // ── 用量聚合 ───────────────────────────────────────────────────────────────
  type AggRow = {
    ti: number;
    to: number;
    m1_should: number;
    m1_did: number;
    m2_did: number;
    m3_should: number;
    m3_did: number;
  };
  type ModelRow = { model: string | null; ti: number; to: number };
  type GroupRow = { group_id: string; ti: number; to: number };

  const aggStmt = db.prepare(`
    SELECT SUM(input_tokens) as ti, SUM(output_tokens) as "to",
      SUM(COALESCE(m1_compaction_injected,0)) as m1_should,
      SUM(COALESCE(m1_summary_extracted,  0)) as m1_did,
      SUM(COALESCE(m2_constraint_injected,0)) as m2_did,
      SUM(COALESCE(m3_compress_injected,  0)) as m3_should,
      SUM(COALESCE(m3_compress_applied,   0)) as m3_did
    FROM usage WHERE ts >= ?
  `);
  const toAgg = (row: unknown): AggRow => {
    const r = row as Record<string, unknown>;
    return {
      ti: safe(r['ti']),
      to: safe(r['to']),
      m1_should: safe(r['m1_should']),
      m1_did: safe(r['m1_did']),
      m2_did: safe(r['m2_did']),
      m3_should: safe(r['m3_should']),
      m3_did: safe(r['m3_did']),
    };
  };

  const todayAgg = toAgg(aggStmt.get(todayStart));
  const weekAgg = toAgg(aggStmt.get(weekAgo));
  const monthAgg = toAgg(aggStmt.get(monthAgo));

  const monthByModel = (
    db
      .prepare(
        `
    SELECT model, SUM(input_tokens) as ti, SUM(output_tokens) as "to"
    FROM usage WHERE ts >= ? GROUP BY model
  `,
      )
      .all(monthAgo) as unknown[]
  ).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      model: row['model'] as string | null,
      ti: safe(row['ti']),
      to: safe(row['to']),
    } as ModelRow;
  });
  const monthByGroup = (
    db
      .prepare(
        `
    SELECT group_id, SUM(input_tokens) as ti, SUM(output_tokens) as "to"
    FROM usage WHERE ts >= ? GROUP BY group_id
    ORDER BY (SUM(input_tokens)+SUM(output_tokens)) DESC
  `,
      )
      .all(monthAgo) as unknown[]
  ).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      group_id: String(row['group_id'] ?? ''),
      ti: safe(row['ti']),
      to: safe(row['to']),
    } as GroupRow;
  });

  // ── 优化效果聚合（日/周/月） ────────────────────────────────────────────────
  type EffRow = {
    m1t: number;
    m1s: number;
    m1n: number;
    tot_in: number;
    m2norm: number;
    m2con: number;
    m2n: number;
    tot_out: number;
    m3b: number;
    m3a: number;
  };
  const toEff = (row: unknown): EffRow => {
    const r = row as Record<string, unknown>;
    return {
      m1t: safe(r['m1t']),
      m1s: safe(r['m1s']),
      m1n: safe(r['m1n']),
      tot_in: safe(r['tot_in']),
      m2norm: safe(r['m2norm']),
      m2con: safe(r['m2con']),
      m2n: safe(r['m2n']),
      tot_out: safe(r['tot_out']),
      m3b: safe(r['m3b']),
      m3a: safe(r['m3a']),
    };
  };
  const effStmt = db.prepare(`
    SELECT
      AVG(CASE WHEN m1_summary_extracted=1 THEN transcript_size_bytes END) as m1t,
      AVG(CASE WHEN m1_seed_used=1         THEN seed_size_bytes       END) as m1s,
      SUM(CASE WHEN m1_summary_extracted=1 THEN 1 ELSE 0 END)             as m1n,
      SUM(input_tokens)                                                    as tot_in,
      AVG(CASE WHEN m2_constraint_injected=0 THEN output_tokens END)      as m2norm,
      AVG(CASE WHEN m2_constraint_injected=1 THEN output_tokens END)      as m2con,
      SUM(CASE WHEN m2_constraint_injected=1 THEN 1 ELSE 0 END)           as m2n,
      SUM(output_tokens)                                                   as tot_out,
      AVG(CASE WHEN m3_compress_applied=1 THEN claudemd_size_bytes       END) as m3b,
      AVG(CASE WHEN m3_compress_applied=1 THEN claudemd_size_after_bytes END) as m3a
    FROM usage WHERE ts >= ?
  `);
  const todayEff = toEff(effStmt.get(todayStart));
  const weekEff = toEff(effStmt.get(weekAgo));
  const monthEff = toEff(effStmt.get(monthAgo));

  db.close();

  // ── 费用计算 ───────────────────────────────────────────────────────────────
  const costByModel = (rows: ModelRow[]) =>
    rows.reduce((s, r) => {
      const p = getPrice(r.model);
      return s + (r.ti / 1e6) * p.inp + (r.to / 1e6) * p.out;
    }, 0);
  const costAgg = (a: AggRow) => (a.ti / 1e6) * 3 + (a.to / 1e6) * 15;

  // ── 优化效果计算 ────────────────────────────────────────────────────────────
  // M1：省 input tokens（用字节估算）
  const m1Eff = (e: EffRow) => {
    if (e.m1n <= 0 || e.m1t <= 0 || e.m1s <= 0) return null;
    const saved = Math.round(((e.m1t - e.m1s) / BYTES_PER_TOKEN) * e.m1n);
    const without = e.tot_in + saved;
    return {
      without,
      saved,
      ratio: Math.round((saved / without) * 100),
      cost: (saved / 1e6) * getPrice(null).inp,
    };
  };
  // M2：省 output tokens（精确值）
  const m2Eff = (e: EffRow) => {
    if (e.m2n <= 0 || e.m2norm <= 0 || e.m2con <= 0) return null;
    const saved = Math.round((e.m2norm - e.m2con) * e.m2n);
    const without = e.tot_out + saved;
    return {
      without,
      saved,
      ratio: Math.round((saved / without) * 100),
      cost: (saved / 1e6) * getPrice(null).out,
    };
  };
  // M3：省 input tokens/消息（无法统计总量）
  const m3PerMsg = (e: EffRow) => {
    if (e.m3b <= 0 || e.m3a <= 0) return null;
    return {
      perMsg: Math.round((e.m3b - e.m3a) / BYTES_PER_TOKEN),
      ratio: Math.round((1 - e.m3a / e.m3b) * 100),
    };
  };

  // 格式：无优化量→省量(占比)/费用
  const fmtEff = (e: ReturnType<typeof m1Eff>): string => {
    if (!e || e.saved <= 0) return '—';
    return `${fmtM(e.without)}→${fmtM(e.saved)}(${e.ratio}%)/${fmtCost(e.cost)}`;
  };

  // ── 报表组装 ───────────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`📊 *Token 用量报表*\n`);

  // 用量（日/周/月）
  lines.push(`**💰 用量 & 费用**`);
  const usageLine = (icon: string, label: string, a: AggRow, cost: number) => {
    lines.push(`${icon} ${label}：${fmtM(a.ti + a.to)} / ${fmtCost(cost)}`);
    lines.push(`　↳ ⬆️ ${fmtM(a.ti)}  ⬇️ ${fmtM(a.to)}`);
  };
  usageLine('📅', '今日', todayAgg, costAgg(todayAgg));
  usageLine('📆', '本周', weekAgg, costAgg(weekAgg));
  usageLine('🗓', '近30天', monthAgg, costByModel(monthByModel));

  if (monthByGroup.length > 1) {
    lines.push(`\n**📦 各群组（月）**`);
    for (const g of monthByGroup) {
      const t = g.ti + g.to;
      if (t > 0) lines.push(`• 🗂 ${g.group_id}：${fmtM(t)}`);
    }
  }

  // 监控（今日，每项一行）
  const rate = (did: number, should: number) =>
    should > 0
      ? `${did}/${should}(${Math.round((did / should) * 100)}%)`
      : `${did}次`;
  lines.push(`\n**🔧 优化监控（今日）**`);
  lines.push(`M1 压缩  ${rate(todayAgg.m1_did, todayAgg.m1_should)}`);
  lines.push(`M2 响应  ${todayAgg.m2_did}次`);
  lines.push(`M3 系统  ${rate(todayAgg.m3_did, todayAgg.m3_should)}`);

  // 效果（日/周/月，每个机制分行展示）
  lines.push(`\n**📈 优化效果**`);
  const pushEff = (
    label: string,
    td: ReturnType<typeof m1Eff>,
    wk: ReturnType<typeof m1Eff>,
    mo: ReturnType<typeof m1Eff>,
  ) => {
    lines.push(label);
    lines.push(`  今 ${fmtEff(td)}`);
    lines.push(`  周 ${fmtEff(wk)}`);
    lines.push(`  月 ${fmtEff(mo)}`);
  };
  pushEff('M1 压缩', m1Eff(todayEff), m1Eff(weekEff), m1Eff(monthEff));
  pushEff('M2 响应', m2Eff(todayEff), m2Eff(weekEff), m2Eff(monthEff));
  const m3 = m3PerMsg(monthEff) ?? m3PerMsg(weekEff) ?? m3PerMsg(todayEff);
  lines.push(
    `M3 系统  ${m3 ? `省~${m3.perMsg.toLocaleString()}tok/消息(-${m3.ratio}%)` : '暂无记录'}`,
  );

  return lines.join('\n');
}

async function runTokenStats(chatJid: string): Promise<void> {
  const ch = findChannel(channels, chatJid);
  try {
    const msg = await buildTokenStatsMessage();
    await ch?.sendMessage(chatJid, msg);
  } catch (err) {
    logger.warn({ err }, 'runTokenStats failed');
    await ch?.sendMessage(chatJid, '❌ 获取 token 用量失败，请查看日志。');
  }
}

async function runCompact(chatJid: string): Promise<void> {
  const group = registeredGroups[chatJid];
  const ch = findChannel(channels, chatJid);
  if (!group) {
    await ch?.sendMessage(chatJid, '❌ 此群组未注册，无法压缩。');
    return;
  }

  let output: ContainerOutput;
  try {
    output = await runContainerAgent(
      group,
      {
        prompt: '/compact',
        sessionId: sessions[group.folder],
        groupFolder: group.folder,
        chatJid,
        isMain: group.isMain === true,
        assistantName: ASSISTANT_NAME,
      },
      (_proc, _containerName) => {},
      async (result) => {
        if (result.newSessionId) sessions[group.folder] = result.newSessionId;
      },
    );
    if (output.newSessionId) sessions[group.folder] = output.newSessionId;
    const msg =
      output.status === 'success'
        ? '✅ 对话历史已压缩。'
        : '❌ 压缩失败，请查看日志。';
    await ch?.sendMessage(chatJid, msg);
  } catch (err) {
    logger.error({ error: err }, 'runCompact failed');
    await ch?.sendMessage(chatJid, `❌ 压缩失败: ${String(err)}`);
  }
}

async function runStatus(chatJid: string): Promise<void> {
  const ch = findChannel(channels, chatJid);
  const groupCount = Object.keys(registeredGroups).length;
  const uptime = formatUptime(Date.now() - processStartTime);
  const lines = [
    `🤖 *NanoClaw 状态*`,
    `⏱ 运行时间：${uptime}`,
    `📦 已注册群组：${groupCount}`,
  ];
  await ch?.sendMessage(chatJid, lines.join('\n'));
}

async function runOptTest(chatJid: string): Promise<void> {
  const group = registeredGroups[chatJid];
  const ch = findChannel(channels, chatJid);
  if (!group) {
    await ch?.sendMessage(chatJid, '❌ 此群组未注册，无法执行测试。');
    return;
  }

  await ch?.sendMessage(chatJid, '🔍 启动 Token 优化测试中...');

  let testResult = '';

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: '请简短回复："测试完成"。',
        sessionId: sessions[group.folder],
        groupFolder: group.folder,
        chatJid,
        isMain: group.isMain === true,
        assistantName: ASSISTANT_NAME,
        extraEnvVars: { NANOCLAW_OPT_TEST: '1' },
      },
      (_proc, _containerName) => {},
      async (result) => {
        if (result.result) testResult = result.result;
      },
    );

    if (!testResult && output.result) testResult = output.result;
    if (!testResult) testResult = '⚠️ 测试完成但无输出，请检查容器日志。';
  } catch (err) {
    logger.error({ error: err }, 'runOptTest failed');
    testResult = `❌ 测试失败: ${String(err)}`;
  }

  await ch?.sendMessage(chatJid, testResult);
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onResetSession: (chatJid: string) => {
      const group = registeredGroups[chatJid];
      if (!group) return;
      delete sessions[group.folder];
      deleteSession(group.folder);
      queue.closeStdin(chatJid);
      queue.killContainer(chatJid);
      // Delete the per-group agent-runner-src so next container startup
      // re-copies from container/agent-runner/src, picking up latest code.
      const agentRunnerDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agent-runner-src',
      );
      if (fs.existsSync(agentRunnerDir)) {
        fs.rmSync(agentRunnerDir, { recursive: true, force: true });
        logger.info(
          { chatJid, group: group.name, agentRunnerDir },
          '/new: agent-runner-src removed for fresh copy',
        );
      }
      logger.info(
        { chatJid, group: group.name },
        '/new: session reset + container killed',
      );
    },
    onOptTest: runOptTest,
    onTokenStats: runTokenStats,
    onCompact: runCompact,
    onStatus: runStatus,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    editMessage: (jid, messageId, text) => {
      const channel = findChannel(channels, jid);
      return channel?.editMessage?.(jid, messageId, text) ?? Promise.resolve();
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
