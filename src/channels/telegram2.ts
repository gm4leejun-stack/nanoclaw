// telegram2.ts — second Telegram bot for @JoyfulMind_bot (Quant-CC)
import { Bot } from 'grammy';
import { TelegramChannel } from './telegram.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';

const QUANT_API = process.env.QUANT_CC_API || 'http://localhost:8001';
const REQUEST_TIMEOUT_MS = 12000;
const ALLOWED_FIXED_KEYS = new Set([
  'stoploss_pct',
  'take_profit_pct',
  'roll_dte_max',
  'rebalance_threshold',
  'open_signal_min',
]);

type QuantResponse = Record<string, unknown> | Array<unknown> | null;

class QuantApiError extends Error {
  statusCode?: number;
  errorType: string;

  constructor(message: string, errorType: string, statusCode?: number) {
    super(message);
    this.name = 'QuantApiError';
    this.errorType = errorType;
    this.statusCode = statusCode;
  }
}

function formatNumber(value: unknown, digits = 2): string {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : '-';
}

function formatCompactValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function previewText(text: string, maxLen = 180): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

async function fetchQuantJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${QUANT_API}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const text = await resp.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!resp.ok) {
      const detail =
        typeof data === 'string'
          ? previewText(data)
          : previewText(
              String(
                (data as Record<string, unknown> | null)?.detail ||
                  resp.statusText ||
                  `HTTP ${resp.status}`,
              ),
            );
      throw new QuantApiError(detail, 'http_error', resp.status);
    }
    return data as T;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new QuantApiError('请求超时', 'timeout');
    }
    if (err instanceof QuantApiError) {
      throw err;
    }
    throw new QuantApiError(String(err?.message || err), 'fetch_error');
  } finally {
    clearTimeout(timeout);
  }
}

function replyError(prefix: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `❌ ${prefix}失败: ${previewText(message, 200)}`;
}

function formatRows(
  rows: Array<Record<string, unknown>>,
  fields: Array<[string, string]>,
  limit = 5,
): string {
  if (!rows.length) return '暂无数据';
  return rows
    .slice(0, limit)
    .map((row, idx) => {
      const body = fields
        .map(([key, label]) => `${label}: ${formatCompactValue(row[key])}`)
        .join(' | ');
      return `${idx + 1}. ${body}`;
    })
    .join('\n');
}

function formatAccountSummary(data: QuantResponse): string {
  const rows = Array.isArray(data) ? data : [];
  const lines = formatRows(
    rows as Array<Record<string, unknown>>,
    [
      ['account', '账户'],
      ['cash', '现金'],
      ['stock_value', '持仓市值'],
      ['unrealized_pnl', '浮动盈亏'],
      ['total', '合计'],
    ],
    10,
  );
  return ['📊 账户汇总', lines].join('\n');
}

function formatPositions(data: QuantResponse): string {
  const rows = Array.isArray(data) ? data : [];
  const lines = formatRows(
    rows as Array<Record<string, unknown>>,
    [
      ['account', '账户'],
      ['symbol', '标的'],
      ['position_type', '类型'],
      ['quantity', '数量'],
      ['avg_strike', '均价'],
      ['expiry_date', '到期'],
    ],
    10,
  );
  return ['📌 当前持仓', lines].join('\n');
}

function formatTrades(data: QuantResponse): string {
  const rows = Array.isArray(data) ? data : [];
  const lines = formatRows(
    rows as Array<Record<string, unknown>>,
    [
      ['symbol', '标的'],
      ['trade_type', '类型'],
      ['quantity', '数量'],
      ['premium', '权利金'],
      ['strike', '行权价'],
      ['timestamp', '时间'],
    ],
    10,
  );
  return ['🧾 最近成交', lines].join('\n');
}

function formatLatestRec(data: QuantResponse): string {
  if (!data || Array.isArray(data)) return '🤖 当前没有未确认的 AI 建议';
  const row = data as Record<string, unknown>;
  const parts = [
    `标的: ${formatCompactValue(row.symbol)}`,
    `建议: ${formatCompactValue(row.recommendation_type)}`,
    `置信度: ${formatCompactValue(row.ai_confidence)}`,
  ];
  const rationale = row.rationale
    ? `理由: ${previewText(String(row.rationale), 120)}`
    : '';
  return ['🤖 最新 AI 建议', parts.join(' | '), rationale]
    .filter(Boolean)
    .join('\n');
}

function formatMarketData(data: QuantResponse): string {
  if (!data || Array.isArray(data)) return '🌐 暂无市场数据';
  const row = data as Record<string, unknown>;
  const highlights: string[] = [];
  for (const key of [
    'spy_price',
    'qqq_price',
    'vix',
    'market_regime',
    'sentiment',
  ]) {
    if (key in row) {
      highlights.push(`${key}: ${formatCompactValue(row[key])}`);
    }
  }
  if (Array.isArray(row.symbols)) {
    highlights.push(`symbols: ${row.symbols.length}`);
  }
  const summary =
    highlights.length > 0
      ? highlights.join(' | ')
      : `keys: ${Object.keys(row).slice(0, 8).join(', ')}`;
  return ['🌐 市场数据', summary].join('\n');
}

function formatHelp(): string {
  return [
    'ℹ️ 可用指令',
    '/summary - 账户汇总',
    '/positions - 当前持仓',
    '/trades - 最近成交',
    '/rec - 最新 AI 建议',
    '/market - 市场数据',
    '/fs - 固定策略详情',
    '/fsu key=value ... - 更新固定策略',
    '/help - 查看指令',
  ].join('\n');
}

async function handleQuantCommand(
  ctx: any,
  command: string,
  title: string,
  path: string,
  formatter: (data: QuantResponse) => string,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const data = await fetchQuantJson<QuantResponse>(path);
    logger.info(
      {
        command,
        endpoint: path,
        latency_ms: Date.now() - startedAt,
        status_code: 200,
        ok: true,
        error_type: null,
      },
      'Quant-CC command handled',
    );
    await ctx.reply(formatter(data));
  } catch (err) {
    const statusCode =
      err instanceof QuantApiError ? (err.statusCode ?? null) : null;
    const errorType =
      err instanceof QuantApiError ? err.errorType : 'unknown_error';
    logger.error(
      {
        error: err,
        command,
        endpoint: path,
        latency_ms: Date.now() - startedAt,
        status_code: statusCode,
        ok: false,
        error_type: errorType,
      },
      'Quant-CC command fetch failed',
    );
    await ctx.reply(replyError(title, err));
  }
}

function parseFixedStrategyArgs(input: string): Record<string, number> {
  const updates: Record<string, number> = {};
  const parts = input
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) {
      throw new Error(`参数格式错误: ${part}（应为 key=value）`);
    }
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!ALLOWED_FIXED_KEYS.has(key)) {
      throw new Error(`不支持的键: ${key}`);
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      throw new Error(`值不是数字: ${key}=${raw}`);
    }
    updates[key] = num;
  }

  return updates;
}

async function handleFixedStrategyGet(ctx: any): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await fetchQuantJson<{
      ok?: boolean;
      version?: string;
      rule_engine?: Record<string, number | null>;
      detail?: string;
    }>('/api/fixed_strategy');

    if (!result.ok) {
      logger.error(
        {
          command: 'fs',
          endpoint: '/api/fixed_strategy',
          latency_ms: Date.now() - startedAt,
          status_code: null,
          ok: false,
          error_type: 'api_not_ok',
          detail: result.detail || null,
        },
        'Quant-CC command fetch failed',
      );
      await ctx.reply(`❌ 查询固定策略失败: ${result.detail || '未知错误'}`);
      return;
    }

    const e = result.rule_engine || {};
    const text = [
      '📏 固定策略（当前）',
      `版本: ${result.version || '-'}`,
      `stoploss_pct: ${e.stoploss_pct ?? '未设置'}`,
      `take_profit_pct: ${e.take_profit_pct ?? '未设置'}`,
      `roll_dte_max: ${e.roll_dte_max ?? '未设置'}`,
      `rebalance_threshold: ${e.rebalance_threshold ?? '未设置'}`,
      `open_signal_min: ${e.open_signal_min ?? '未设置'}`,
      '',
      '更新示例:',
      '/fsu open_signal_min=0.70 stoploss_pct=0.08 roll_dte_max=7',
    ].join('\n');
    logger.info(
      {
        command: 'fs',
        endpoint: '/api/fixed_strategy',
        latency_ms: Date.now() - startedAt,
        status_code: 200,
        ok: true,
        error_type: null,
      },
      'Quant-CC command handled',
    );
    await ctx.reply(text);
  } catch (err: any) {
    const statusCode =
      err instanceof QuantApiError ? (err.statusCode ?? null) : null;
    const errorType =
      err instanceof QuantApiError ? err.errorType : 'unknown_error';
    logger.error(
      {
        error: err,
        command: 'fs',
        endpoint: '/api/fixed_strategy',
        latency_ms: Date.now() - startedAt,
        status_code: statusCode,
        ok: false,
        error_type: errorType,
      },
      'Quant-CC command fetch failed',
    );
    await ctx.reply(`❌ 查询固定策略失败: ${err?.message || String(err)}`);
  }
}

async function handleFixedStrategyUpdate(ctx: any): Promise<void> {
  const startedAt = Date.now();
  const text = (ctx.message?.text || '').trim();
  const rest = text.replace(/^\/fsu(?:@\w+)?\s*/i, '');
  if (!rest) {
    await ctx.reply(
      '用法: /fsu key=value [key=value ...]\n' +
        '可用键: stoploss_pct take_profit_pct roll_dte_max rebalance_threshold open_signal_min',
    );
    return;
  }

  let updates: Record<string, number>;
  try {
    updates = parseFixedStrategyArgs(rest);
  } catch (err: any) {
    await ctx.reply(`❌ 参数错误: ${err?.message || String(err)}`);
    return;
  }

  try {
    const result = await fetchQuantJson<{
      ok?: boolean;
      version?: string;
      updated?: Record<string, number>;
      detail?: string;
    }>('/api/fixed_strategy/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });

    if (!result.ok) {
      logger.error(
        {
          command: 'fsu',
          endpoint: '/api/fixed_strategy/update',
          latency_ms: Date.now() - startedAt,
          status_code: null,
          ok: false,
          error_type: 'api_not_ok',
          detail: result.detail || null,
        },
        'Quant-CC command fetch failed',
      );
      await ctx.reply(`❌ 更新固定策略失败: ${result.detail || '未知错误'}`);
      return;
    }

    const lines = ['✅ 固定策略已更新', `版本: ${result.version || '-'}`];
    const updated = result.updated || {};
    for (const [k, v] of Object.entries(updated)) {
      lines.push(`${k} = ${v}`);
    }
    logger.info(
      {
        command: 'fsu',
        endpoint: '/api/fixed_strategy/update',
        latency_ms: Date.now() - startedAt,
        status_code: 200,
        ok: true,
        error_type: null,
      },
      'Quant-CC command handled',
    );
    await ctx.reply(lines.join('\n'));
  } catch (err: any) {
    const statusCode =
      err instanceof QuantApiError ? (err.statusCode ?? null) : null;
    const errorType =
      err instanceof QuantApiError ? err.errorType : 'unknown_error';
    logger.error(
      {
        error: err,
        command: 'fsu',
        endpoint: '/api/fixed_strategy/update',
        latency_ms: Date.now() - startedAt,
        status_code: statusCode,
        ok: false,
        error_type: errorType,
      },
      'Quant-CC command fetch failed',
    );
    await ctx.reply(`❌ 更新固定策略失败: ${err?.message || String(err)}`);
  }
}

function quantCcCallbackHandler(bot: Bot): void {
  // rec_* 按钮中继到 Quant-CC callback API
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    if (!data.startsWith('rec_')) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      await ctx.answerCallbackQuery();
      const result = await fetchQuantJson<{
        reply_text: string | null;
        reply_markup: Record<string, unknown> | null;
      }>('/api/handle_callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (result.reply_text) {
        const sendOpts: Record<string, unknown> = { parse_mode: 'HTML' };
        if (result.reply_markup) sendOpts.reply_markup = result.reply_markup;
        await ctx.reply(result.reply_text, sendOpts);
      }
    } catch (err) {
      logger.error({ error: err }, 'handle_callback fetch failed');
      await ctx.reply('处理失败，请稍后重试');
    }
  });

  // 固定策略：命令层直连 API，避免走 LLM 会话链路
  bot.command('fs', async (ctx) => {
    await handleFixedStrategyGet(ctx);
  });

  bot.command('fsu', async (ctx) => {
    await handleFixedStrategyUpdate(ctx);
  });

  bot.command('summary', async (ctx) => {
    await handleQuantCommand(
      ctx,
      'summary',
      '查询账户汇总',
      '/api/account_summary',
      formatAccountSummary,
    );
  });

  bot.command('positions', async (ctx) => {
    await handleQuantCommand(
      ctx,
      'positions',
      '查询持仓',
      '/api/positions',
      formatPositions,
    );
  });

  bot.command('trades', async (ctx) => {
    await handleQuantCommand(
      ctx,
      'trades',
      '查询成交',
      '/api/recent_trades',
      formatTrades,
    );
  });

  bot.command('rec', async (ctx) => {
    await handleQuantCommand(
      ctx,
      'rec',
      '查询 AI 建议',
      '/api/latest_rec',
      formatLatestRec,
    );
  });

  bot.command('market', async (ctx) => {
    await handleQuantCommand(
      ctx,
      'market',
      '查询市场数据',
      '/api/market_data',
      formatMarketData,
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(formatHelp());
  });
}

registerChannel('telegram2', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN_2']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN_2 || envVars.TELEGRAM_BOT_TOKEN_2 || '';
  if (!token) {
    logger.warn('Telegram2: TELEGRAM_BOT_TOKEN_2 not set, skipping');
    return null;
  }
  return new TelegramChannel(
    token,
    opts,
    'tg2',
    [
      { command: 'positions', description: '当前持仓' },
      { command: 'summary', description: '账户汇总（实时市值）' },
      { command: 'trades', description: '最近10笔成交' },
      { command: 'rec', description: '最新 AI 建议' },
      { command: 'market', description: '市场数据 + 技术指标' },
      { command: 'fs', description: '查看固定策略' },
      { command: 'fsu', description: '更新固定策略阈值' },
      { command: 'help', description: '查看所有指令' },
    ],
    {},
    quantCcCallbackHandler,
  );
});
