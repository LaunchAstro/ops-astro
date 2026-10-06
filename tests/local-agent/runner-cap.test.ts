// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859, GPT): the local runner's cap. A call is let in only when the
// tokens left cover what it is charged before codex runs (50,000 and its
// prompt's bytes), so that charge never passes the cap; a call that reports
// more than was left is recorded as reported and its answer withheld.

import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ledgerTotal } from '../../apps/local-agent/ledger.ts';
import { runnerWorld } from './runner-world.ts';
import { makeWorld } from './world.ts';

const { logged, start, call } = runnerWorld();

const CAP = 2_000_000;
const message = { fields: { message: 'What is on the board today?' } };
/** What a call with this message is charged before codex runs: 50,000 and its 27 bytes. */
const NEED = 50_027;
const used = (tokens: number): string =>
  `${JSON.stringify({ at: 'then', model: 'gpt-6.1-sol', inputTokens: tokens, outputTokens: 0 })}\n`;

// eslint-disable-next-line max-lines-per-function -- one case per way the cap holds
describe('the cap stops a run', () => {
  it('refuses with less left than a call needs, in plain words, and never spawns codex', async () => {
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

  it('refuses with fewer tokens left than one call is charged, so the cap holds', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(1_980_000));
    w.knobs({ usage: { input_tokens: 25_000, output_tokens: 0 } });
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls()).toHaveLength(0);
    expect(ledgerTotal(w.agentHome, 2_000_000)).toBe(1_980_000);
  });

  it('withholds the answer of a call that used more than the tokens it was given', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(1_940_000));
    w.knobs({ usage: { input_tokens: 70_000, output_tokens: 0 } });
    const reply = await call(r, message);
    expect(reply.body).toMatchObject({ text: '', code: 'LOCAL_CAP_REACHED' });
    // What it used is recorded as it was reported, never trimmed to fit.
    expect(ledgerTotal(w.agentHome, 2_000_000)).toBe(2_010_000);
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls()).toHaveLength(1);
  });

  it('lets a call in with exactly what it needs left, and answers usage of all of it', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(CAP - NEED));
    w.knobs({ usage: { input_tokens: NEED, output_tokens: 0 } });
    expect((await call(r, message)).body?.['code']).toBeNull();
    expect(ledgerTotal(w.agentHome, CAP)).toBe(CAP);
  });

  it('refuses with one token less than the call needs, and spawns nothing', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(CAP - NEED + 1));
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls()).toHaveLength(0);
  });

  it.each([
    ['an answer', {}],
    ['a plan at its limit', { before: [{ type: 'error', message: 'You hit your usage limit.' }] }],
  ])('withholds %s one token over what was left, charged as reported', async (_label, knobs) => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(CAP - NEED));
    w.knobs({ ...knobs, usage: { input_tokens: NEED + 1, output_tokens: 0 } });
    expect((await call(r, message)).body).toMatchObject({ text: '', code: 'LOCAL_CAP_REACHED' });
    expect(ledgerTotal(w.agentHome, CAP)).toBe(CAP + 1);
  });

  it("counts the prompt's bytes in what a call needs, and charges them up front", async () => {
    const { w, r } = await start();
    const dense = { fields: { message: 'é'.repeat(30_000) } };
    w.write('ledger.jsonl', used(CAP - 109_999));
    expect((await call(r, dense)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls()).toHaveLength(0);
    w.write('ledger.jsonl', used(CAP - 110_000));
    expect((await call(r, dense)).body?.['code']).toBeNull();
    expect(w.ledger()[1]).toMatchObject({ inputTokens: 110_000, outputTokens: 0 });
  });

  it('refuses the next call once one leaves less than a call needs', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(1_940_000));
    w.knobs({ usage: { input_tokens: 15_000, output_tokens: 0 } });
    expect((await call(r, message)).body?.['code']).toBeNull();
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls()).toHaveLength(1);
  });

  it("replaces a call's unknown charge with what it used, never adds the two", async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(1_900_000));
    w.knobs({ usage: { input_tokens: 15_000, output_tokens: 0 } });
    expect((await call(r, message)).body?.['code']).toBeNull();
    // 1,915,000 used, 85,000 left: added, the 50,000 charge would have left under 50,000.
    expect((await call(r, message)).body?.['code']).toBeNull();
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

  it('spawns nothing once a ledger row cannot be written', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', '');
    const { chmodSync } = await import('node:fs');
    chmodSync(`${w.agentHome}/ledger.jsonl`, 0o400);
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_GPT_FAILED');
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls()).toHaveLength(0);
  });
});

describe('the cap the owner sets', () => {
  it('an approval with no configured cap is the cap from the next call, never past 10,000,000', async () => {
    const { w, r } = await start();
    w.write('ledger.jsonl', used(1_990_000));
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    w.write('approvals.json', { capTokens: 99_000_000 });
    w.write('ledger.jsonl', used(9_960_000));
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

  it('a configured cap above 2,000,000 lapses to the default once its approval is gone', async () => {
    const w = makeWorld();
    w.write('approvals.json', { capTokens: 3_000_000 });
    const { r } = await start({ OPS_LOCAL_AGENT_CAP_TOKENS: '3000000' }, w);
    w.write('ledger.jsonl', used(1_990_000));
    rmSync(`${w.agentHome}/approvals.json`);
    expect((await call(r, message)).body?.['code']).toBe('LOCAL_CAP_REACHED');
    expect(w.calls()).toHaveLength(0);
  });
});
