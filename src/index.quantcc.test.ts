import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __test__ } from './index.js';
import * as db from './db.js';

describe('Quant-CC multi-engine client contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.QUANT_CC_ENGINE_ID;
    delete process.env.QUANT_CC_BASE_URL;
    vi.spyOn(db, 'setRouterState').mockImplementation(() => {});
  });

  it('adds engine header and body engine_id for async analysis requests', async () => {
    process.env.QUANT_CC_ENGINE_ID = 'nanoclaw-main';
    process.env.QUANT_CC_BASE_URL = 'http://localhost:8001';
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ task_id: 123 })),
      } as any)
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify({ task: { status: 'succeeded', result: {} } }),
          ),
      } as any);

    await __test__.submitQuantCcAnalysis({
      symbol: 'AMZN',
      assetClass: 'B',
      forceRefresh: false,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/run_analysis_async',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Engine-Id': 'nanoclaw-main',
        }),
        body: JSON.stringify({
          symbol: 'AMZN',
          asset_class: 'B',
          force_refresh: false,
          engine_id: 'nanoclaw-main',
        }),
        signal: expect.any(Object),
      }),
    );
  });

  it('preserves the first HTTP contract error instead of masking it with a later fetch failure', async () => {
    process.env.QUANT_CC_ENGINE_ID = 'nanoclaw-main';
    process.env.QUANT_CC_BASE_URL = 'http://localhost:8001';
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ detail: 'missing engine_id' })),
      } as any)
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(
      __test__.quantCcFetchJson('/api/run_analysis_async'),
    ).rejects.toThrow(/http_400:.*missing engine_id/i);
  });

  it('uses a single explicit local Quant-CC base URL by default', () => {
    expect(__test__.quantCcBaseCandidates()).toEqual(['http://localhost:8001']);
  });

  it('does not throw when the post-submit task poll fails', async () => {
    process.env.QUANT_CC_ENGINE_ID = 'nanoclaw-main';
    global.fetch = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(__test__.maybePollQuantCcTask(321)).resolves.toBeNull();
  });

  it('adds engine header to engine event feed and ack requests', async () => {
    process.env.QUANT_CC_ENGINE_ID = 'nanoclaw-main';

    expect(
      __test__.quantCcRequestInit('/api/engine_events?after_id=0&limit=5'),
    ).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Engine-Id': 'nanoclaw-main',
        }),
      }),
    );

    expect(
      __test__.quantCcRequestInit('/api/engine_events/17/ack', {
        method: 'POST',
      }),
    ).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Engine-Id': 'nanoclaw-main',
        }),
      }),
    );
  });

  it('waits for a matching engine result event and acks it', async () => {
    process.env.QUANT_CC_ENGINE_ID = 'nanoclaw-main';
    process.env.QUANT_CC_BASE_URL = 'http://localhost:8001';
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            ok: true,
            events: [
              {
                id: 17,
                event_type: 'analysis_result_ready',
                status: 'succeeded',
                payload: { task_id: 123, status: 'succeeded' },
              },
            ],
            next_after_id: 17,
          }),
        ),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ ok: true, acked: true })),
      } as any);

    const event = await __test__.waitForQuantCcEngineEvent(123, {
      attempts: 1,
      intervalMs: 0,
      limit: 5,
    });
    const acked = await __test__.ackQuantCcEngineEvent(17);

    expect(event).toEqual(
      expect.objectContaining({
        id: 17,
        payload: expect.objectContaining({ task_id: 123 }),
      }),
    );
    expect(acked).toBe(true);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8001/api/engine_events?after_id=0&limit=5',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Engine-Id': 'nanoclaw-main',
        }),
        signal: expect.any(Object),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8001/api/engine_events/17/ack',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Engine-Id': 'nanoclaw-main',
        }),
        signal: expect.any(Object),
      }),
    );
  });

  it('delivers final analysis result from engine events even when task result suppresses user echo', async () => {
    process.env.QUANT_CC_ENGINE_ID = 'nanoclaw-main';
    process.env.QUANT_CC_BASE_URL = 'http://localhost:8001';
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const channel = { sendMessage } as any;
    const group = { folder: 'quant_cc' } as any;

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ task_id: 123 })),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            task: {
              status: 'succeeded',
              result: {
                suppress_user_echo: true,
                message: 'AMZN 建议已推送',
              },
            },
          }),
        ),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            ok: true,
            events: [
              {
                id: 17,
                event_type: 'analysis_result_ready',
                payload: {
                  task_id: 123,
                  status: 'succeeded',
                  result_json: JSON.stringify({
                    message: 'AMZN 建议已推送',
                    suppress_user_echo: true,
                    rec_id: 843,
                  }),
                },
              },
            ],
            next_after_id: 17,
          }),
        ),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ ok: true, acked: true })),
      } as any);

    await __test__.handleQuantCcFastPath(
      group,
      'tg2:7783067080',
      channel,
      'amzn持仓分析',
      '2026-04-10T10:46:16.000Z',
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'tg2:7783067080',
      'AMZN 建议已推送',
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      'http://localhost:8001/api/engine_events?after_id=0&limit=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Engine-Id': 'nanoclaw-main',
        }),
        signal: expect.any(Object),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      4,
      'http://localhost:8001/api/engine_events/17/ack',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Engine-Id': 'nanoclaw-main',
        }),
        signal: expect.any(Object),
      }),
    );
  });
});
