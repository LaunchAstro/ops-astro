// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859, GPT): the local runner answers the broker on loopback through
// `codex exec`, here a fake binary. The default model unless the owner
// approves another; every call's tokens in the ledger; the cap and the model
// gate refuse before anything is spawned; the plan's usage limit has its own
// refusal; a runner key or planted canary never leaves the runner.

import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createRunner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { LOCAL_GPT_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { runnerWorld } from './runner-world.ts';
import { CANARY, RUNNER_KEY } from './world.ts';

const { logged, opened, start, call } = runnerWorld();

const message = { fields: { message: 'What is on the board today?' } };
/** What a call with this message is charged before codex runs: 50,000 and its 27 bytes. */
const NEED = 50_027;

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
    // Charged as unknown (50,000 and the prompt's 27 bytes) before codex runs, then what it used.
    const [charged, used_] = w.ledger();
    expect(charged).toMatchObject({ model: 'gpt-6.1-sol', inputTokens: NEED, outputTokens: 0 });
    expect(used_).toMatchObject({ id: charged?.['id'], inputTokens: 120, outputTokens: 7 });
    expect(w.ledger()).toHaveLength(2);
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
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: input });
  });

  it('answers the plan at its usage limit LOCAL_PLAN_LIMIT, in plain words', async () => {
    const { w, r } = await start();
    w.knobs({ limit: true });
    expect((await call(r, message)).body).toMatchObject({ text: '', code: 'LOCAL_PLAN_LIMIT' });
    expect(logged.join('\n')).toContain('usage limit');
  });

  it("charges a call killed at its timeout 50,000 tokens and its prompt's bytes, never nothing", async () => {
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
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: NEED, outputTokens: 0 });
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
    expect(r.host).toBe('127.0.0.1');
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
