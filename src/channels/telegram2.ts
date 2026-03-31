// telegram2.ts — second Telegram bot for @JoyfulMind_bot (Quant-CC)
import { Bot } from 'grammy';
import { TelegramChannel } from './telegram.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';

const QUANT_API = process.env.QUANT_CC_API || 'http://localhost:8001';
const ALLOWED_FIXED_KEYS = new Set([
  'stoploss_pct',
  'take_profit_pct',
  'roll_dte_max',
  'rebalance_threshold',
  'open_signal_min',
]);

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
  try {
    const resp = await fetch(`${QUANT_API}/api/fixed_strategy`);
    const result = (await resp.json()) as {
      ok?: boolean;
      version?: string;
      rule_engine?: Record<string, number | null>;
      detail?: string;
    };

    if (!resp.ok || !result.ok) {
      await ctx.reply(`❌ 查询固定策略失败: ${result.detail || resp.statusText}`);
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
    await ctx.reply(text);
  } catch (err: any) {
    logger.error({ error: err }, 'fixed strategy query failed');
    await ctx.reply(`❌ 查询固定策略失败: ${err?.message || String(err)}`);
  }
}

async function handleFixedStrategyUpdate(ctx: any): Promise<void> {
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
    const resp = await fetch(`${QUANT_API}/api/fixed_strategy/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const result = (await resp.json()) as {
      ok?: boolean;
      version?: string;
      updated?: Record<string, number>;
      detail?: string;
    };

    if (!resp.ok || !result.ok) {
      await ctx.reply(`❌ 更新固定策略失败: ${result.detail || resp.statusText}`);
      return;
    }

    const lines = ['✅ 固定策略已更新', `版本: ${result.version || '-'}`];
    const updated = result.updated || {};
    for (const [k, v] of Object.entries(updated)) {
      lines.push(`${k} = ${v}`);
    }
    await ctx.reply(lines.join('\n'));
  } catch (err: any) {
    logger.error({ error: err }, 'fixed strategy update failed');
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
      const resp = await fetch(`${QUANT_API}/api/handle_callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      const result = (await resp.json()) as {
        reply_text: string | null;
        reply_markup: Record<string, unknown> | null;
      };
      await ctx.answerCallbackQuery();
      if (result.reply_text) {
        const sendOpts: Record<string, unknown> = { parse_mode: 'HTML' };
        if (result.reply_markup) sendOpts.reply_markup = result.reply_markup;
        await ctx.reply(result.reply_text, sendOpts);
      }
    } catch (err) {
      logger.error({ error: err }, 'handle_callback fetch failed');
      await ctx.answerCallbackQuery({ text: '处理失败，请稍后重试' });
    }
  });

  // 固定策略：命令层直连 API，避免走 LLM 会话链路
  bot.command('fs', async (ctx) => {
    await handleFixedStrategyGet(ctx);
  });

  bot.command('fsu', async (ctx) => {
    await handleFixedStrategyUpdate(ctx);
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
    {
      positions: '/positions',
      summary: '/summary',
      trades: '/trades',
      rec: '/rec',
      market: '/market',
      help: '/help',
    },
    quantCcCallbackHandler,
  );
});
