import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: any[]) => any;

const registryState = vi.hoisted(() => ({
  telegram2Factory: null as null | ((opts: any) => any),
}));

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn((name: string, factory: (opts: any) => any) => {
    if (name === 'telegram2') {
      registryState.telegram2Factory = factory;
    }
  }),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ TELEGRAM_BOT_TOKEN_2: 'test-token' })),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;
    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      setMyCommands: vi.fn().mockResolvedValue(undefined),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'joyfulmind_bot', id: 4242 });
    }

    stop() {}
  },
}));

import './telegram2.js';
import { TelegramChannel } from './telegram.js';
import { logger } from '../logger.js';

function currentBot() {
  return botRef.current;
}

function createChannel() {
  const factory = registryState.telegram2Factory;
  if (!factory) throw new Error('telegram2 factory not registered');
  const opts = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
  const channel = factory(opts) as TelegramChannel;
  return { channel, opts };
}

function mockFetchJson(
  body: unknown,
  ok = true,
  status = 200,
  statusText = 'OK',
) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(text),
  } as any);
}

async function triggerCommand(name: string, ctx: any) {
  const handler = currentBot().commandHandlers.get(name);
  if (!handler) throw new Error(`missing handler: ${name}`);
  await handler(ctx);
}

async function triggerCallback(ctx: any) {
  const handlers = currentBot().filterHandlers.get('callback_query:data') || [];
  for (const handler of handlers) {
    await handler(ctx);
  }
}

describe('telegram2 command router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers explicit fast-path handlers and leaves alias fallback empty', async () => {
    const { channel } = createChannel();

    await channel.connect();

    expect(Array.from(currentBot().commandHandlers.keys())).toEqual(
      expect.arrayContaining([
        'fs',
        'fsu',
        'summary',
        'positions',
        'trades',
        'rec',
        'market',
        'help',
      ]),
    );
    expect(Reflect.get(channel as any, 'commandAliases')).toEqual({});
    expect(currentBot().api.setMyCommands).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ command: 'summary' }),
        expect.objectContaining({ command: 'positions' }),
        expect.objectContaining({ command: 'trades' }),
        expect.objectContaining({ command: 'rec' }),
        expect.objectContaining({ command: 'market' }),
        expect.objectContaining({ command: 'fs' }),
        expect.objectContaining({ command: 'fsu' }),
        expect.objectContaining({ command: 'help' }),
      ]),
    );
  });

  it('/summary calls Quant-CC account summary API directly', async () => {
    const { channel } = createChannel();
    await channel.connect();

    mockFetchJson([
      {
        account: '美股账户',
        cash: 12500.5,
        stock_value: 32000,
        floating_pnl: 412.34,
        realized_pnl: 1888.66,
        total_pnl: 2301.0,
        csp_used: 7500.0,
        csp_available_cash: 5000.5,
        total: 44500.5,
      },
    ]);

    const ctx = { reply: vi.fn() };
    await triggerCommand('summary', ctx);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/account_summary',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('📊 账户汇总'),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('👤 美股账户'),
    );
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('🧾 资产'));
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('💵 现金与额度'),
    );
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('📈 盈亏'));
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('总资产 $44,500.50'),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('CSP使用额度 $7,500'),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('可开仓现金 $5,000.50'),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('已实现盈亏 +$1,888.66'),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('总盈亏 +$2,301'),
    );
  });

  it('/rec and /market use direct Quant-CC endpoints', async () => {
    const { channel } = createChannel();
    await channel.connect();

    mockFetchJson({
      symbol: 'AAPL',
      recommendation_type: 'hold',
      ai_confidence: 4,
      rationale: '等待更明确的突破',
    });
    const recCtx = { reply: vi.fn() };
    await triggerCommand('rec', recCtx);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/latest_rec',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(recCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('🤖 最新 AI 建议'),
    );

    mockFetchJson({
      spy_price: 502.14,
      qqq_price: 425.88,
      vix: 17.2,
      symbols: ['SPY', 'QQQ'],
    });
    const marketCtx = { reply: vi.fn() };
    await triggerCommand('market', marketCtx);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/market_data',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(marketCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('🌐 市场数据'),
    );
    expect(marketCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('symbols: 2'),
    );
  });

  it('/positions and /trades use direct Quant-CC endpoints', async () => {
    const { channel } = createChannel();
    await channel.connect();

    mockFetchJson([
      {
        account: 'ibkr1',
        symbol: 'AAPL',
        position_type: 'stock',
        quantity: 100,
        cost_basis: 180.5,
      },
      {
        account: 'ibkr1',
        symbol: 'AAPL',
        position_type: 'csp',
        quantity: 1,
        avg_strike: 170,
        expiry_date: '2026-04-24',
        cost_basis: 4.35,
      },
    ]);
    const posCtx = { reply: vi.fn() };
    await triggerCommand('positions', posCtx);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/positions',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(posCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('📌 持仓｜'),
    );
    expect(posCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('🟦 正股('),
    );
    expect(posCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('×$180.50'),
    );
    expect(posCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('🟧 期权('),
    );
    expect(posCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('×行权$170'),
    );
    expect(posCtx.reply).toHaveBeenCalledWith(expect.stringContaining('(D'));

    mockFetchJson([
      {
        symbol: 'AAPL',
        trade_type: 'sell_put',
        quantity: 1,
      },
    ]);
    const tradesCtx = { reply: vi.fn() };
    await triggerCommand('trades', tradesCtx);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/recent_trades',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(tradesCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('🧾 最近成交'),
    );
  });

  it('returns deterministic error and logs observability fields when API fails', async () => {
    const { channel } = createChannel();
    await channel.connect();

    mockFetchJson(
      { detail: 'downstream error' },
      false,
      503,
      'Service Unavailable',
    );
    const ctx = { reply: vi.fn() };
    await triggerCommand('summary', ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('❌ 查询账户汇总失败'),
    );
    expect((logger as any).error).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'summary',
        endpoint: '/api/account_summary',
        ok: false,
        error_type: 'http_error',
      }),
      'Quant-CC command fetch failed',
    );
  });

  it('handles callback rec_* via Quant-CC API and acknowledges callback quickly', async () => {
    const { channel } = createChannel();
    await channel.connect();

    mockFetchJson({
      reply_text: '已处理',
      reply_markup: null,
    });
    const ctx = {
      callbackQuery: { data: 'rec_confirm:123' },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn(),
    };
    await triggerCallback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/handle_callback',
      expect.objectContaining({ method: 'POST', signal: expect.any(Object) }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('已处理', { parse_mode: 'HTML' });
  });

  it('returns callback failure message when Quant-CC callback API fails', async () => {
    const { channel } = createChannel();
    await channel.connect();

    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const ctx = {
      callbackQuery: { data: 'rec_confirm:123' },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn(),
    };
    await triggerCallback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith('处理失败，请稍后重试');
  });

  it('/fs and /fsu continue to work on the deterministic router', async () => {
    const { channel } = createChannel();
    await channel.connect();

    mockFetchJson({
      ok: true,
      version: 'v1',
      rule_engine: {
        stoploss_pct: 0.12,
        take_profit_pct: 0.24,
        roll_dte_max: 7,
        rebalance_threshold: 0.3,
        open_signal_min: 0.7,
      },
    });
    const fsCtx = { reply: vi.fn() };
    await triggerCommand('fs', fsCtx);
    expect(fsCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('固定策略（当前）'),
    );
    expect((logger as any).info).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'fs',
        endpoint: '/api/fixed_strategy',
        ok: true,
      }),
      'Quant-CC command handled',
    );

    mockFetchJson({
      ok: true,
      version: 'v2',
      updated: { open_signal_min: 0.66 },
    });
    const fsuCtx = {
      reply: vi.fn(),
      message: { text: '/fsu open_signal_min=0.66' },
    };
    await triggerCommand('fsu', fsuCtx);
    expect(fsuCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining('固定策略已更新'),
    );
    expect((logger as any).info).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'fsu',
        endpoint: '/api/fixed_strategy/update',
        ok: true,
      }),
      'Quant-CC command handled',
    );
  });

  it('/help replies with the deterministic command list', async () => {
    const { channel } = createChannel();
    await channel.connect();

    const ctx = { reply: vi.fn() };
    await triggerCommand('help', ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('/summary - 账户汇总'),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('/fsu key=value ... - 更新固定策略'),
    );
  });
});
