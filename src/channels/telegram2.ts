// telegram2.ts — second Telegram bot for @JoyfulMind_bot (Quant-CC)
import { Bot } from 'grammy';
import { TelegramChannel } from './telegram.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';

const QUANT_API =
  process.env.QUANT_CC_API || 'http://localhost:8001';

function quantCcCallbackHandler(bot: Bot): void {
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
