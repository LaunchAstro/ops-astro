// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859, GPT): the local runner answers the broker on loopback through
// `codex exec`, here a fake binary. The default model unless the owner
// approves another; every call's tokens in the ledger; the cap and the model
// gate refuse before anything is spawned; the plan's usage limit has its own
// refusal; a runner key or planted canary never leaves the runner.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunner, type Runner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { LOCAL_GPT_COMPOSE, LOCAL_GPT_PATH } from '../../packages/core-connectors/src/index.ts';
import { CANARY, makeWorld, RUNNER_KEY, type World } from './world.ts';

const logged: string[] = [];
const opened: Runner[] = [];
let world: World | undefined;
afterEach(async () => {
  logged.length = 0;
  await Promise.all(opened.splice(0).map(async (runner) => await runner.close()));
  world?.remove();
  world = undefined;
});

async function start(
  overrides: Readonly<Record<string, string | undefined>> = {},
  w: World = makeWorld(),
): Promise<{ w: World; r: Runner }> {
  world = w;
  const read = readSettings({ ...w.env, ...overrides }, w.userHome);
  if (!read.ok) throw new Error(`settings refused: ${read.code}`);
  const r = await createRunner(read.settings, (line) => logged.push(line));
  opened.push(r);
  return { w, r };
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
  readonly raw: string;
}

async function call(
  r: Runner,
  body: unknown,
  init: { key?: string | null; path?: string; method?: string; signal?: AbortSignal } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = init.key === undefined ? RUNNER_KEY : init.key;
  if (key !== null) headers['authorization'] = `Bearer ${key}`;
  const method = init.method ?? 'POST';
  const response = await fetch(`${r.origin}${init.path ?? LOCAL_GPT_PATH}`, {
    method,
    headers,
    ...(init.signal === undefined ? {} : { signal: init.signal }),
    ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
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
const used = (tokens: number): string =>
  `${JSON.stringify({ at: 'then', model: 'gpt-6.1-sol', inputTokens: tokens, outputTokens: 0 })}\n`;

describe('a message answered through codex exec', () => {
  it('answers on the default model and writes the tokens to the ledger', async () => {
    const { w, r } = await start();
    w.knobs({ text: 'Two tasks are due.' });
    const reply = await call(r, message);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      text: 'Two tasks are due.',
      model: 'gpt-6.1-sol',
      usage: { input: 120, output: 7 },
      code: null,
    });
    expect(w.calls()[0]?.stdin).toBe('What is on the board today?');
    expect(w.ledger()).toEqual([
      { at: expect.any(String) as string, model: 'gpt-6.1-sol', inputTokens: 120, outputTokens: 7 },
    ]);
  });

  it("gives up before custody's own timeout for the call", async () => {
    const { w } = await start();
    const read = readSettings(w.env, w.userHome);
    expect(read.ok && read.settings.timeoutMs).toBeLessThan(LOCAL_GPT_COMPOSE.timeoutMs);
  });
});

describe('a call that does not answer', () => {
  it.each([
    ['a failed turn', { failed: true }, 90],
    ['a tool call', { before: [{ type: 'item.completed', item: { type: 'web_search' } }] }, 120],
  ])('answers %s LOCAL_GPT_FAILED and records its tokens', async (_label, knobs, input) => {
    const { w, r } = await start();
    w.knobs(knobs);
    expect((await call(r, message)).body).toMatchObject({ text: '', code: 'LOCAL_GPT_FAILED' });
    expect(w.ledger()[0]).toMatchObject({ inputTokens: input });
  });

  it('answers the plan at its usage limit LOCAL_PLAN_LIMIT, in plain words', async () => {
    const { w, r } = await start();
    w.knobs({ limit: true });
    expect((await call(r, message)).body).toMatchObject({ text: '', code: 'LOCAL_PLAN_LIMIT' });
    expect(logged.join('\n')).toContain('usage limit');
  });

  it('charges a call killed at its timeout 50,000 tokens, never nothing', async () => {
    const { w, r } = await start();
    w.knobs({ waitMs: 5_000 });
    const read = readSettings(w.env, w.userHome);
    if (!read.ok) throw new Error(read.code);
    const quick = await createRunner({ ...read.settings, timeoutMs: 200 }, () => null, 0).catch(
      (error: unknown) => error,
    );
    // The home is held by the first runner: a second on it never starts.
    expect(String(quick)).toContain('LOCAL_HOME_IN_USE');
    await r.close();
    opened.length = 0;
    const lone = await createRunner({ ...read.settings, timeoutMs: 200 }, () => null, 0);
    opened.push(lone);
    expect((await call(lone, message)).body).toMatchObject({ code: 'LOCAL_GPT_FAILED' });
    expect(w.ledger()[0]).toMatchObject({ inputTokens: 50_000, outputTokens: 0 });
  });
});

describe('the cap stops a run', () => {
  it('refuses with under 20,000 tokens left, in plain words, and never spawns codex', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(1_990_000));
    const reply = await call(r, message);
    expect(reply.body).toEqual({
      text: '',
      model: 'gpt-6.1-sol',
      usage: { input: 0, output: 0 },
      code: 'LOCAL_CAP_REACHED',
    });
    expect(w.calls()).toHaveLength(0);
    expect(logged.join('\n')).toContain('needs the owner’s yes to raise it');
  });

  it('stops the run once a call takes the total to the cap', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(1_970_000));
    w.knobs({ usage: { input_tokens: 15_000, output_tokens: 0 } });
    expect((await call(r, message)).body?.['code']).toBeNull();
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls()).toHaveLength(1);
  });

  it.each([
    ['a line that is not JSON', 'not json\n'],
    ['a row with no token counts', `${JSON.stringify({ costUsd: 0 })}\n`],
    ['negative tokens', used(-5)],
  ])('counts a ledger with %s as the cap, and spawns nothing', async (_label, ledger) => {
    const { w, r } = await start();
    w.write('ledger.jsonl', ledger);
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls()).toHaveLength(0);
  });

  it('spawns nothing after a ledger row could not be written', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', '');
    const { chmodSync } = await import('node:fs');
    chmodSync(`${w.agentHome}/ledger.jsonl`, 0o400);
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_GPT_FAILED');
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls()).toHaveLength(1);
  });
});

describe('the cap the owner sets', () => {
  it('an approval with no configured cap is the cap from the next call, never past 10,000,000', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(1_990_000));
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    w.write('approvals.json', { capTokens: 99_000_000 });
    w.write('ledger.jsonl', used(9_985_000));
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    w.write('ledger.jsonl', used(1_990_000));
    expect((await call(r, message)).body?.['code']).toBeNull();
  });

  it('a cap the owner configured below an earlier approval is still the cap', async () => {
    const w = makeWorld();
    w.write('approvals.json', { capTokens: 5_000_000 });
    const { r } = await start({ OPS_LOCAL_AGENT_CAP_TOKENS: '100000' }, w);
    w.write('ledger.jsonl', used(90_000));
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
  });
});

describe('the model gate', () => {
  it.each([['gpt-5'], ['o3'], ['gpt-6.1-sol-pro']])(
    'refuses %s without the owner’s approval and spawns nothing',
    async (model) => {
      const { w, r } = await start();
      const reply = await call(r, { ...message, model });
      expect(reply.body).toMatchObject({ text: '', code: 'LOCAL_MODEL_NOT_APPROVED', model });
      expect(w.calls()).toHaveLength(0);
    },
  );

  it('runs a model the approval names', async () => {
    const { w, r } = await start();
    w.write('approvals.json', { models: ['gpt-5'] });
    expect((await call(r, { ...message, model: 'gpt-5' })).body?.['code']).toBeNull();
    const argv = w.calls()[0]?.argv ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-5');
  });

  it('refuses a malformed model name with 400', async () => {
    const { w, r } = await start();
    const reply = await call(r, { ...message, model: 'gpt-5 --dangerously-bypass' });
    expect(reply.status).toBe(400);
    expect(w.calls()).toHaveLength(0);
  });
});

describe('the runner’s door', () => {
  it.each([
    ['missing', null],
    ['wrong', 'runner-key-0123456789abcdef0123456789abcdeX'],
    ['short', 'x'],
  ])('refuses a %s bearer with 401 and spawns nothing', async (_label, key) => {
    const { w, r } = await start();
    expect((await call(r, message, { key })).status).toBe(401);
    expect(w.calls()).toHaveLength(0);
  });

  it('refuses another path, another method, a malformed and an oversized body', async () => {
    const { w, r } = await start();
    expect((await call(r, message, { path: '/v1/other' })).status).toBe(404);
    expect((await call(r, message, { method: 'GET' })).status).toBe(405);
    expect((await call(r, '{"fields":')).status).toBe(400);
    expect((await call(r, { fields: { message: 7 } })).status).toBe(400);
    expect((await call(r, { fields: {} })).status).toBe(400);
    expect((await call(r, { fields: { message: 'x'.repeat(70 * 1024) } })).status).toBe(413);
    expect(w.calls()).toHaveLength(0);
  });

  it('listens on loopback only', async () => {
    const { r } = await start();
    expect(new URL(r.origin).hostname).toBe('127.0.0.1');
  });

  it('never runs a call whose caller has gone while it waited its turn', async () => {
    const { w, r } = await start();
    w.knobs({ waitMs: 600 });
    const first = call(r, message);
    const leaving = new AbortController();
    const second = call(r, message, { signal: leaving.signal }).catch(() => null);
    await sleep(100);
    leaving.abort();
    await Promise.all([first, second]);
    await sleep(200);
    expect(w.calls()).toHaveLength(1);
  });
});

describe('the planted canary', () => {
  it('never reaches the answer, the ledger or the codex process', async () => {
    const { w, r } = await start();
    const reply = await call(r, message);
    const child = w.calls()[0];
    const everything = [reply.raw, JSON.stringify(w.ledger()), JSON.stringify(child)].join('\n');
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain(RUNNER_KEY);
  });
});
