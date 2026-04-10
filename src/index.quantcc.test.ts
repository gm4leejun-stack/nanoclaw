import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __test__,
} from './index.js';

describe('Quant-CC multi-engine client contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.QUANT_CC_ENGINE_ID;
    delete process.env.QUANT_CC_BASE_URL;
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
        text: vi.fn().mockResolvedValue(
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
        text: vi.fn().mockResolvedValue(JSON.stringify({ detail: 'missing engine_id' })),
      } as any)
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(__test__.quantCcFetchJson('/api/run_analysis_async')).rejects.toThrow(
      /http_400:.*missing engine_id/i,
    );
  });

  it('uses a single explicit local Quant-CC base URL by default', () => {
    expect(__test__.quantCcBaseCandidates()).toEqual(['http://localhost:8001']);
  });

  it('does not throw when the post-submit task poll fails', async () => {
    process.env.QUANT_CC_ENGINE_ID = 'nanoclaw-main';
    global.fetch = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(__test__.maybePollQuantCcTask(321)).resolves.toBeNull();
  });
});
