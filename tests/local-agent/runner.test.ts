// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the local runner answers the broker on loopback through the
// owner's Claude Code session (`claude -p`), here a fake binary. Haiku by
// default; every call in the ledger; the cap and the model gate refuse before
// anything is spawned; a runner key or planted canary never leaves the runner.

import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunner, type Runner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { CANARY, makeWorld, RUNNER_KEY, type World } from './world.ts';

const PATH = '/v1/local-claude/complete';

const logged: string[] = [];
let world: World | undefined;
let runner: Runner | undefined;
afterEach(async () => {
  logged.length = 0;
  await runner?.close();
  runner = undefined;
  world?.remove();
  world = undefined;
});

async function start(
  overrides: (w: World) => Readonly<Record<string, string | undefined>> = () => ({}),
): Promise<{ w: World; r: Runner }> {
  world = makeWorld();
  const read = readSettings({ ...world.env, ...overrides(world) }, world.userHome);
  if (!read.ok) throw new Error(`settings refused: ${read.code}`);
  runner = await createRunner(read.settings, (line) => logged.push(line));
  return { w: world, r: runner };
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
  readonly raw: string;
}

async function call(
  r: Runner,
  body: unknown,
  init: { key?: string | null; path?: string; method?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = init.key === undefined ? RUNNER_KEY : init.key;
  if (key !== null) headers['authorization'] = `Bearer ${key}`;
  const response = await fetch(`${r.origin}${init.path ?? PATH}`, {
    method: init.method ?? 'POST',
    headers,
    ...((init.method ?? 'POST') === 'GET'
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, raw };
}

const message = { fields: { message: 'What is on the board today?' } };

describe('a message answered through claude -p', () => {
  it('answers on Haiku by default, with no tools, no session and no MCP', async () => {
    const { w, r } = await start();
    const reply = await call(r, message);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      text: 'Answered: What is on the board today?',
      model: 'claude-haiku-4-5-20251001',
      usage: { input: 12, output: 7 },
      code: null,
      costUsd: 0.0012,
    });
    const [only] = w.calls('hey');
    expect(only?.argv.slice(0, 5)).toEqual(['-p', '--model', 'haiku', '--output-format', 'json']);
    const argv = only?.argv ?? [];
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv).toContain('--no-session-persistence');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('10.00');
    expect(only?.stdin).toBe('What is on the board today?');
  });

  it('runs the child in an empty folder under the runner home, on the chosen seat', async () => {
    const { w, r } = await start(() => ({ OPS_LOCAL_AGENT_SEAT: 'nathan' }));
    await call(r, message);
    const [only] = w.calls('nathan');
    expect(only?.env['CLAUDE_CONFIG_DIR']).toBe(w.seatDir('nathan'));
    expect(only?.cwd.endsWith('/agent/cwd')).toBe(true);
    expect(w.calls('hey')).toHaveLength(0);
  });
});

describe('the ledger and a failed call', () => {
  it('writes a ledger row from Claude Code’s JSON output', async () => {
    const { w, r } = await start();
    w.knobs('hey', { costUsd: 0.25 });
    await call(r, message);
    const [row] = w.ledger();
    expect(row).toMatchObject({
      seat: 'hey',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 12,
      outputTokens: 7,
      costUsd: 0.25,
    });
    expect(typeof row?.['at']).toBe('string');
  });

  it('passes the budget left under the cap as Claude Code’s own stop', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', `${JSON.stringify({ costUsd: 9.125 })}\n`);
    await call(r, message);
    const argv = w.calls('hey')[0]?.argv ?? [];
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('0.87');
  });

  it('answers a failed claude call LOCAL_CLAUDE_FAILED without its stderr', async () => {
    const { w, r } = await start();
    w.knobs('hey', { exitCode: 3, stderr: 'stderr-detail-never-shown' });
    const reply = await call(r, message);
    expect(reply.body).toMatchObject({ text: '', code: 'LOCAL_CLAUDE_FAILED' });
    expect(reply.raw).not.toContain('stderr-detail-never-shown');
  });

  it('records the cost of an errored result and answers LOCAL_CLAUDE_FAILED', async () => {
    const { w, r } = await start();
    w.knobs('hey', { isError: true, costUsd: 0.5 });
    const reply = await call(r, message);
    expect(reply.body).toMatchObject({ text: '', code: 'LOCAL_CLAUDE_FAILED' });
    expect(w.ledger()[0]).toMatchObject({ costUsd: 0.5 });
  });

  it('answers unreadable claude output LOCAL_CLAUDE_FAILED', async () => {
    const { w, r } = await start();
    w.knobs('hey', { raw: 'not json' });
    const reply = await call(r, message);
    expect(reply.body).toMatchObject({ text: '', code: 'LOCAL_CLAUDE_FAILED' });
  });
});

describe('the cap stops a run', () => {
  it('refuses at the cap with LOCAL_CAP_REACHED and never spawns claude', async () => {
    const { w, r } = await start();
    w.write(
      'ledger.jsonl',
      `${JSON.stringify({ costUsd: 6 })}\n${JSON.stringify({ costUsd: 4 })}\n`,
    );
    const reply = await call(r, message);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      text: '',
      model: 'haiku',
      usage: { input: 0, output: 0 },
      code: 'LOCAL_CAP_REACHED',
      costUsd: 0,
    });
    expect(w.calls('hey')).toHaveLength(0);
    expect(logged.join('\n')).toContain('needs the owner\u2019s yes to raise it');
  });

  it('stops the run once a call takes the total to the cap', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', `${JSON.stringify({ costUsd: 9.5 })}\n`);
    w.knobs('hey', { costUsd: 0.5 });
    expect((await call(r, message)).body?.['code']).toBeNull();
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls('hey')).toHaveLength(1);
  });
});

describe('the model gate', () => {
  it.each([['sonnet'], ['opus'], ['fable'], ['claude-opus-5-5']])(
    'refuses %s without the owner’s approval and spawns nothing',
    async (model) => {
      const { w, r } = await start();
      const reply = await call(r, { ...message, model });
      expect(reply.body).toMatchObject({ text: '', code: 'LOCAL_MODEL_NOT_APPROVED', model });
      expect(w.calls('hey')).toHaveLength(0);
    },
  );

  it('runs a model the approval names', async () => {
    const { w, r } = await start();
    w.write('approvals.json', { models: ['sonnet'] });
    const reply = await call(r, { ...message, model: 'sonnet' });
    expect(reply.body?.['code']).toBeNull();
    const argv = w.calls('hey')[0]?.argv ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('refuses a malformed model name with 400', async () => {
    const { w, r } = await start();
    const reply = await call(r, { ...message, model: 'haiku --dangerously-skip-permissions' });
    expect(reply.status).toBe(400);
    expect(w.calls('hey')).toHaveLength(0);
  });
});

describe('the seat’s 85% stop', () => {
  it('refuses with LOCAL_SEAT_OVER_STOP when the seat reads at or past 85%', async () => {
    const { w, r } = await start((laptop) => ({
      OPS_LOCAL_AGENT_SEAT_USAGE_FILE: join(laptop.agentHome, 'usage.json'),
    }));
    w.write('usage.json', { seat: 'hey', percent: 85, at: '2026-10-01T04:00:00Z' });
    const reply = await call(r, message);
    expect(reply.body).toMatchObject({ text: '', code: 'LOCAL_SEAT_OVER_STOP' });
    expect(w.calls('hey')).toHaveLength(0);
  });

  it('runs when the reading is under 85% or is another seat’s', async () => {
    const { w, r } = await start((laptop) => ({
      OPS_LOCAL_AGENT_SEAT_USAGE_FILE: join(laptop.agentHome, 'usage.json'),
    }));
    w.write('usage.json', { seat: 'hey', percent: 84, at: '2026-10-01T04:00:00Z' });
    expect((await call(r, message)).body?.['code']).toBeNull();
    w.write('usage.json', { seat: 'nathan', percent: 99, at: '2026-10-01T04:00:00Z' });
    expect((await call(r, message)).body?.['code']).toBeNull();
  });
});

describe('the runner’s door', () => {
  it.each([
    ['missing', null],
    ['wrong', 'runner-key-0123456789abcdef0123456789abcdeX'],
    ['short', 'x'],
  ])('refuses a %s bearer with 401 and spawns nothing', async (_label, key) => {
    const { w, r } = await start();
    const reply = await call(r, message, { key });
    expect(reply.status).toBe(401);
    expect(w.calls('hey')).toHaveLength(0);
  });

  it('refuses another path, another method, a malformed and an oversized body', async () => {
    const { w, r } = await start();
    expect((await call(r, message, { path: '/v1/other' })).status).toBe(404);
    expect((await call(r, message, { method: 'GET' })).status).toBe(405);
    expect((await call(r, '{"fields":')).status).toBe(400);
    expect((await call(r, { fields: { message: 7 } })).status).toBe(400);
    expect((await call(r, { fields: {} })).status).toBe(400);
    expect((await call(r, { fields: { message: 'x'.repeat(70 * 1024) } })).status).toBe(413);
    expect(w.calls('hey')).toHaveLength(0);
  });

  it('listens on loopback only', async () => {
    const { r } = await start();
    expect(new URL(r.origin).hostname).toBe('127.0.0.1');
  });
});

describe('the planted canary', () => {
  it('never reaches the answer, the ledger or the claude process', async () => {
    const { w, r } = await start();
    const reply = await call(r, message);
    const child = w.calls('hey')[0];
    // macOS adds its own `__CF_USER_TEXT_ENCODING` to a process; nothing else is the runner's.
    // USER and LOGNAME are how Claude Code finds the seat's login in the keychain.
    const passed = Object.keys(child?.env ?? {}).filter((name) => !name.startsWith('__CF_'));
    expect(passed.toSorted()).toEqual([
      'CLAUDE_CONFIG_DIR',
      'HOME',
      'LANG',
      'LOGNAME',
      'PATH',
      'USER',
    ]);
    const everything = [reply.raw, JSON.stringify(w.ledger()), JSON.stringify(child)].join('\n');
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain(RUNNER_KEY);
    expect(child?.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(child?.env['OPS_LOCAL_AGENT_KEY']).toBeUndefined();
  });
});
