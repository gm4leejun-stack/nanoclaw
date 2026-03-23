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
  return new TelegramChannel(token, opts);
});
