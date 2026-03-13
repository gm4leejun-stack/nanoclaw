/**
 * Integration tests for token optimization mechanisms.
 * Uses fake transcript files + mocked claude-agent-sdk query().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── Mock claude-agent-sdk before importing index ──────────────────────────────

let mockQueryImpl: (options?: unknown) => AsyncGenerator<Record<string, unknown>>;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (options: unknown) => mockQueryImpl(options),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQueryThatReturns(text: string, sessionId = 'test-session-001', model?: string) {
  return async function* (_options?: unknown) {
    yield { type: 'system', subtype: 'init', session_id: sessionId, ...(model ? { model } : {}) };
    yield {
      type: 'result',
      subtype: 'success',
      result: text,
      usage: { input_tokens: 500, output_tokens: 100 },
    };
  };
}

const OUTPUT_START = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END = '---NANOCLAW_OUTPUT_END---';

function parseOutputs(stdout: string): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  const regex = new RegExp(`${OUTPUT_START}\\n([\\s\\S]*?)\\n${OUTPUT_END}`, 'g');
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    results.push(JSON.parse(match[1]));
  }
  return results;
}

// ── Test Setup ────────────────────────────────────────────────────────────────
// WORKSPACE_DIR 在模块 import 时求值，必须在 import 前设置环境变量（用固定路径）

const workspaceDir = '/tmp/nanoclaw-test-workspace-fixed';
const homeDir = '/tmp/nanoclaw-test-home-fixed';
process.env.NANOCLAW_WORKSPACE = workspaceDir;
process.env.NANOCLAW_TEST = '1';
process.env.HOME = homeDir;

const BASE_INPUT = {
  prompt: '你好',
  groupFolder: 'telegram_test',
  chatJid: 'tg:99999',
  isMain: false,
  assistantName: 'TestBot',
};

beforeEach(() => {
  // 每次测试前重建目录（确保干净状态）
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });

  fs.mkdirSync(path.join(workspaceDir, 'group'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'shared', 'usage'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'ipc', 'input'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude', 'projects', '-workspace-group'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

// ── Import after env is set ───────────────────────────────────────────────────

const { runQuery, extractCompactSummary, extractCompressedClaudeMd, validateCompressedClaudeMd, getTranscriptSize } =
  await import('./index.js');

// ── Pure function tests ───────────────────────────────────────────────────────

describe('extractCompactSummary', () => {
  it('extracts summary from valid tag', () => {
    const text = '正常回复\n<compact_summary>\n摘要内容\n</compact_summary>';
    expect(extractCompactSummary(text)).toBe('摘要内容');
  });

  it('returns null when no tag', () => {
    expect(extractCompactSummary('普通回复')).toBeNull();
  });
});

describe('extractCompressedClaudeMd', () => {
  it('extracts compressed content', () => {
    const text = '回复<compressed_claudemd>压缩内容</compressed_claudemd>';
    expect(extractCompressedClaudeMd(text)).toBe('压缩内容');
  });

  it('returns null when no tag', () => {
    expect(extractCompressedClaudeMd('普通回复')).toBeNull();
  });
});

describe('validateCompressedClaudeMd', () => {
  it('passes when all constraint lines are preserved', () => {
    const original = '必须使用中文回复\n普通说明文字\n禁止泄露密码';
    const compressed = '必须使用中文回复\n禁止泄露密码';
    expect(validateCompressedClaudeMd(original, compressed).valid).toBe(true);
  });

  it('fails when constraint line is missing', () => {
    const original = '必须使用中文回复\n禁止泄露密码';
    const compressed = '必须使用中文回复'; // 缺少禁止行
    const result = validateCompressedClaudeMd(original, compressed);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain('禁止泄露密码');
  });
});

describe('getTranscriptSize', () => {
  it('returns 0 for undefined sessionId', () => {
    expect(getTranscriptSize(undefined)).toBe(0);
  });

  it('returns 0 for non-existent sessionId', () => {
    expect(getTranscriptSize('nonexistent-session')).toBe(0);
  });

  it('returns correct size for existing transcript', () => {
    const sessionId = 'test-size-session';
    const transcriptPath = path.join(homeDir, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, 'x'.repeat(1000));
    expect(getTranscriptSize(sessionId)).toBe(1000);
  });
});

// ── Integration tests ─────────────────────────────────────────────────────────

describe('机制一：Inline Compaction', () => {
  it('当 transcript > 80KB 时注入压缩指令，提取 compact_summary，输出 compacted=true', async () => {
    const sessionId = 'big-session-001';

    // 创建 > 80KB 的假 transcript
    const transcriptPath = path.join(
      homeDir, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`
    );
    fs.writeFileSync(transcriptPath, 'x'.repeat(85 * 1024));

    // mock query 返回含 compact_summary 的回复
    const summaryContent = '<tool_results>工具结论</tool_results>\n<conversation_summary><completed>已完成事项</completed></conversation_summary>';
    mockQueryImpl = makeQueryThatReturns(
      `正常回复内容\n<compact_summary>\n${summaryContent}\n</compact_summary>`,
      sessionId
    );

    // 捕获 console.log 输出（writeOutput 使用 console.log）
    const loggedLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      loggedLines.push(args.map(String).join(' '));
    });

    try {
      await runQuery('你好', sessionId, '/fake/mcp.js', { ...BASE_INPUT }, {});
    } finally {
      vi.restoreAllMocks();
    }

    const stdout = loggedLines.join('\n');
    const outputs = parseOutputs(stdout);

    // 应有输出且 compacted=true
    const resultOutput = outputs.find(o => o.result !== null);
    expect(resultOutput).toBeDefined();
    expect(resultOutput?.compacted).toBe(true);

    // 回复中不应包含 compact_summary 标签（已被移除）
    expect(String(resultOutput?.result ?? '')).not.toContain('<compact_summary>');

    // seed 文件应被写入
    const seedPath = path.join(workspaceDir, 'group', '.compact-seed.md');
    expect(fs.existsSync(seedPath)).toBe(true);
    expect(fs.readFileSync(seedPath, 'utf-8')).toContain('已完成事项');
  });

  it('当 transcript < 80KB 时不触发压缩', async () => {
    const sessionId = 'small-session-001';

    // 创建 < 80KB 的 transcript
    const transcriptPath = path.join(
      homeDir, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`
    );
    fs.writeFileSync(transcriptPath, 'x'.repeat(10 * 1024));

    mockQueryImpl = makeQueryThatReturns('普通回复', sessionId);

    const loggedLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      loggedLines.push(args.map(String).join(' '));
    });

    try {
      await runQuery('你好', sessionId, '/fake/mcp.js', { ...BASE_INPUT }, {});
    } finally {
      vi.restoreAllMocks();
    }

    const outputs = parseOutputs(loggedLines.join('\n'));
    const resultOutput = outputs.find(o => o.result !== null);
    expect(resultOutput?.compacted).toBeUndefined();

    const seedPath = path.join(workspaceDir, 'group', '.compact-seed.md');
    expect(fs.existsSync(seedPath)).toBe(false);
  });
});

describe('机制二：响应长度控制', () => {
  it('累计 input token 超过周期阈值时注入软约束（通过 usage.db 验证触发）', async () => {
    const sessionId = 'constraint-session-001';

    // 预置 token 状态：距上次注入已有 25000 input tokens（超过 20000 阈值）
    const stateFile = path.join(workspaceDir, 'shared', 'token-opt-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      lastCompactTokens: 0,
      totalInputTokens: 25000,
      lastConstraintInjectedAt: 0,
      recentOutputTokens: [],
      outputMultiplier: 1.5,
      outputAbsoluteY: 700,
      lastInjectedOutputAvg: 0,
    }));

    // 创建小 transcript（不触发机制一）
    const transcriptPath = path.join(
      homeDir, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`
    );
    fs.writeFileSync(transcriptPath, 'x'.repeat(1024));

    // 记录 query 调用时的 systemPrompt 内容
    let capturedSystemPrompt: unknown = undefined;
    mockQueryImpl = async function* (options?: unknown) {
      capturedSystemPrompt = (options as { options?: { systemPrompt?: unknown } } | undefined)?.options?.systemPrompt ?? options;
      yield { type: 'system', subtype: 'init', session_id: sessionId };
      yield { type: 'result', subtype: 'success', result: '简短回复', usage: { input_tokens: 500, output_tokens: 100 } };
    };

    vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runQuery('你好', sessionId, '/fake/mcp.js', { ...BASE_INPUT }, {});
    } finally {
      vi.restoreAllMocks();
    }

    // systemPrompt.append 应包含软约束指令
    const append = (capturedSystemPrompt as { append?: string } | undefined)?.append ?? '';
    expect(append).toContain('结论优先');
  });
});

describe('机制三：CLAUDE.md 自动压缩', () => {
  it('CLAUDE.md > 10KB 时注入压缩指令，验证通过后更新文件', async () => {
    const sessionId = 'claudemd-session-001';

    // 创建 > 10KB 的 CLAUDE.md（含约束行 + 大量解释文字）
    // 代码从 HOME/.claude/CLAUDE.md 读取
    const claudeMdPath = path.join(homeDir, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
    const constraints = '必须使用中文回复\n禁止泄露任何密码';
    const padding = '这是一些解释性文字，可以被压缩删除。\n'.repeat(400); // ~14KB
    fs.writeFileSync(claudeMdPath, constraints + '\n' + padding);

    // mock query 返回压缩后的 CLAUDE.md
    const compressedMd = '必须使用中文回复\n禁止泄露任何密码';
    mockQueryImpl = makeQueryThatReturns(
      `回复内容\n<compressed_claudemd>\n${compressedMd}\n</compressed_claudemd>`,
      sessionId
    );

    const transcriptPath = path.join(
      homeDir, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`
    );
    fs.writeFileSync(transcriptPath, 'x'.repeat(1024));

    vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runQuery('你好', sessionId, '/fake/mcp.js', { ...BASE_INPUT }, {});
    } finally {
      vi.restoreAllMocks();
    }

    // CLAUDE.md 应已被压缩
    const updatedContent = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(updatedContent).toBe(compressedMd);
    expect(updatedContent.length).toBeLessThan(constraints.length + padding.length);
  });
});

// ── usage.db 记录完整性 ───────────────────────────────────────────────────────

import { DatabaseSync } from 'node:sqlite';

describe('usage.db 记录完整性', () => {
  const dbPath = () => path.join(workspaceDir, 'shared', 'usage', 'usage.db');

  it('M1 触发时记录正确', async () => {
    const sessionId = 'db-m1-session-001';
    const transcriptPath = path.join(
      homeDir, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`
    );
    fs.writeFileSync(transcriptPath, 'x'.repeat(85 * 1024));

    const summaryContent = '<tool_results>结论</tool_results>\n<conversation_summary><completed>完成</completed></conversation_summary>';
    mockQueryImpl = makeQueryThatReturns(
      `回复\n<compact_summary>\n${summaryContent}\n</compact_summary>`,
      sessionId
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runQuery('你好', sessionId, '/fake/mcp.js', { ...BASE_INPUT }, {});
    } finally {
      vi.restoreAllMocks();
    }

    const db = new DatabaseSync(dbPath());
    const row = db.prepare('SELECT * FROM usage ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    db.close();

    expect(row.m1_compaction_injected).toBe(1);
    expect(row.m1_summary_extracted).toBe(1);
    expect(Number(row.transcript_size_bytes)).toBeGreaterThan(0);
  });

  it('M1 seed 注入时记录正确', async () => {
    const sessionId = undefined; // 新 session
    const transcriptPath = path.join(
      homeDir, '.claude', 'projects', '-workspace-group', 'seed-session.jsonl'
    );
    fs.writeFileSync(transcriptPath, 'x'.repeat(1024));

    mockQueryImpl = makeQueryThatReturns('普通回复', 'seed-session-created');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runQuery('你好', sessionId, '/fake/mcp.js', { ...BASE_INPUT, compactSeed: 'some seed content' }, {});
    } finally {
      vi.restoreAllMocks();
    }

    const db = new DatabaseSync(dbPath());
    const row = db.prepare('SELECT * FROM usage ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    db.close();

    expect(row.m1_seed_used).toBe(1);
    expect(Number(row.seed_size_bytes)).toBeGreaterThan(0);
  });

  it('M2 触发时记录正确', async () => {
    const sessionId = 'db-m2-session-001';
    const stateFile = path.join(workspaceDir, 'shared', 'token-opt-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      lastCompactTokens: 0,
      totalInputTokens: 25000,
      lastConstraintInjectedAt: 0,
      recentOutputTokens: [],
      outputMultiplier: 1.5,
      outputAbsoluteY: 700,
      lastInjectedOutputAvg: 0,
    }));

    const transcriptPath = path.join(
      homeDir, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`
    );
    fs.writeFileSync(transcriptPath, 'x'.repeat(1024));

    mockQueryImpl = makeQueryThatReturns('简短回复', sessionId);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runQuery('你好', sessionId, '/fake/mcp.js', { ...BASE_INPUT }, {});
    } finally {
      vi.restoreAllMocks();
    }

    const db = new DatabaseSync(dbPath());
    const row = db.prepare('SELECT * FROM usage ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    db.close();

    expect(row.m2_constraint_injected).toBe(1);
    expect(typeof row.output_rolling_avg).toBe('number');
  });

  it('M3 压缩成功时记录正确', async () => {
    const sessionId = 'db-m3-session-001';
    const claudeMdPath = path.join(homeDir, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
    const constraints = '必须使用中文回复\n禁止泄露任何密码';
    const padding = '这是一些解释性文字，可以被压缩删除。\n'.repeat(400);
    fs.writeFileSync(claudeMdPath, constraints + '\n' + padding);

    const compressedMd = '必须使用中文回复\n禁止泄露任何密码';
    mockQueryImpl = makeQueryThatReturns(
      `回复内容\n<compressed_claudemd>\n${compressedMd}\n</compressed_claudemd>`,
      sessionId
    );

    const transcriptPath = path.join(
      homeDir, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`
    );
    fs.writeFileSync(transcriptPath, 'x'.repeat(1024));

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runQuery('你好', sessionId, '/fake/mcp.js', { ...BASE_INPUT }, {});
    } finally {
      vi.restoreAllMocks();
    }

    const db = new DatabaseSync(dbPath());
    const row = db.prepare('SELECT * FROM usage ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    db.close();

    expect(row.m3_compress_injected).toBe(1);
    expect(row.m3_compress_applied).toBe(1);
    expect(row.m3_validation_passed).toBe(1);
    expect(Number(row.claudemd_size_after_bytes)).toBeLessThan(Number(row.claudemd_size_bytes));
  });

  it('model 字段被捕获', async () => {
    const sessionId = 'db-model-session-001';
    const transcriptPath = path.join(
      homeDir, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`
    );
    fs.writeFileSync(transcriptPath, 'x'.repeat(1024));

    mockQueryImpl = makeQueryThatReturns('回复', sessionId, 'claude-test-model');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runQuery('你好', sessionId, '/fake/mcp.js', { ...BASE_INPUT }, {});
    } finally {
      vi.restoreAllMocks();
    }

    const db = new DatabaseSync(dbPath());
    const row = db.prepare('SELECT * FROM usage ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    db.close();

    expect(row.model).toBe('claude-test-model');
  });
});
