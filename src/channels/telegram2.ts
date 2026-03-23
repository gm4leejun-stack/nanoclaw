// telegram2.ts — second Telegram bot for @JoyfulMind_bot (Quant-CC)
import { TelegramChannel } from './telegram.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';

registerChannel('telegram2', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN_2']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN_2 || envVars.TELEGRAM_BOT_TOKEN_2 || '';
  if (!token) {
    logger.warn('Telegram2: TELEGRAM_BOT_TOKEN_2 not set, skipping');
    return null;
  }
  return new TelegramChannel(token, opts, 'tg2', [
    { command: 'positions', description: '当前持仓' },
    { command: 'summary', description: '账户汇总（实时市值）' },
    { command: 'trades', description: '最近10笔成交' },
    { command: 'rec', description: '最新 AI 建议' },
    { command: 'market', description: '市场数据 + 技术指标' },
    { command: 'help', description: '查看所有指令' },
  ]);
});
