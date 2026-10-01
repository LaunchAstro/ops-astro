// SPDX-License-Identifier: AGPL-3.0-only
//
// Reviewer proofs for LA-1 (#859), review 1, at 9514a7a56. Each fails at that
// head for the reason its finding names. Unit level: the real runner, the fake
// `claude` binary, no database.

import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRunner, type Runner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { LOCAL_CLAUDE_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { makeWorld, RUNNER_KEY, type World } from './world.ts';

const PATH = '/v1/local-claude/complete';
const message = { fields: { message: 'What is on the board today?' } };
const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

let world: World | undefined;
const runners: Runner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) {
    // eslint-disable-next-line no-await-in-loop
    await r.close();
  }
  await pause(50);
  world?.remove();
  world = undefined;
});

async function start(
  overrides: Readonly<Record<string, string | undefined>> = {},
  timeoutMs?: number,
): Promise<{ w: World; r: Runner }> {
  world = makeWorld();
  const read = readSettings({ ...world.env, ...overrides }, world.userHome);
  if (!read.ok) throw new Error(`settings refused: ${read.code}`);
  const settings = timeoutMs === undefined ? read.settings : { ...read.settings, timeoutMs };
  const r = await createRunner(settings, () => {});
  runners.push(r);
  return { w: world, r };
}

async function call(
  r: Runner,
  body: unknown = message,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(`${r.origin}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${RUNNER_KEY}` },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  return (await response.json()) as Record<string, unknown>;
}

it('Sol proof, criterion 6: a call the runner kills at its timeout still writes a ledger row, charged the budget it was given', async () => {
  const { w, r } = await start({}, 300);
  w.knobs('hey', { sleepMs: 2_000, costUsd: 0.4 });
  const reply = await call(r);
  expect(reply?.['code']).toBe('LOCAL_CLAUDE_FAILED');
  expect(w.calls('hey')).toHaveLength(1);
  const rows = w.ledger();
  expect(rows).toHaveLength(1);
  // The call ran under `--max-budget-usd 10.00`; its real cost is unknown, so the worst case counts.
  expect(rows[0]?.['costUsd']).toBe(10);
}, 15_000);

it('Sol proof, races: a call whose caller has gone while it waited in the queue never spawns claude', async () => {
  const { w, r } = await start();
  w.knobs('hey', { sleepMs: 800 });
  const first = call(r);
  await pause(200);
  const controller = new AbortController();
  const second = call(r, message, controller.signal).catch(() => null);
  await pause(200);
  controller.abort();
  await second;
  await first;
  // Long enough for a queued second call to spawn and finish.
  await pause(2_000);
  expect(w.calls('hey')).toHaveLength(1);
}, 15_000);

it("Sol proof, races: the runner's own child timeout ends before custody's timeout for the call", () => {
  world = makeWorld();
  const read = readSettings(world.env, world.userHome);
  if (!read.ok) throw new Error(read.code);
  expect(read.settings.timeoutMs).toBeLessThan(LOCAL_CLAUDE_COMPOSE.timeoutMs);
});

it('Sol proof, criterion 7: two runners on one home never both start a call under the cap', async () => {
  world = makeWorld();
  const w = world;
  w.write('ledger.jsonl', `${JSON.stringify({ costUsd: 9.5 })}\n`);
  w.knobs('hey', { sleepMs: 600, costUsd: 0.5 });
  w.knobs('nathan', { sleepMs: 600, costUsd: 0.5 });
  const a = readSettings(w.env, w.userHome);
  const b = readSettings({ ...w.env, OPS_LOCAL_AGENT_SEAT: 'nathan' }, w.userHome);
  if (!a.ok || !b.ok) throw new Error('settings refused');
  const first = await createRunner(a.settings, () => {});
  runners.push(first);
  const second = await createRunner(b.settings, () => {}).catch(() => null);
  // A second runner on the same home refusing to start also closes the race.
  if (second === null) return;
  runners.push(second);
  await Promise.all([call(first), call(second)]);
  expect(w.calls('hey').length + w.calls('nathan').length).toBe(1);
}, 15_000);

it('Sol proof, criterion 6: when a ledger row cannot be written, the next call spawns nothing', async () => {
  const { w, r } = await start();
  w.write('ledger.jsonl', '');
  const file = join(w.agentHome, 'ledger.jsonl');
  chmodSync(file, 0o444);
  try {
    await call(r);
    const next = await call(r);
    expect(next?.['code']).not.toBeNull();
    expect(w.calls('hey').length).toBeLessThanOrEqual(1);
  } finally {
    chmodSync(file, 0o644);
  }
}, 15_000);

it('Sol proof, criterion 7: a ledger that cannot be read counts as the cap, and nothing is spawned', async () => {
  const { w, r } = await start();
  mkdirSync(join(w.agentHome, 'ledger.jsonl'), { recursive: true });
  const reply = await call(r);
  expect(reply?.['code']).toBe('LOCAL_CAP_REACHED');
  expect(w.calls('hey')).toHaveLength(0);
}, 15_000);

it("Sol proof, fence no client data: the claude child never loads the seat's auto memory", async () => {
  const { w, r } = await start();
  await call(r);
  expect(w.calls('hey')[0]?.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1');
}, 15_000);

it("Sol proof, prompt reach: the child expands no slash command or skill and ignores the seat's settings files", async () => {
  const { w, r } = await start();
  await call(r, { fields: { message: '/wrapup' } });
  const argv = w.calls('hey')[0]?.argv ?? [];
  expect(argv).toContain('--disable-slash-commands');
  expect(argv).toContain('--restricted');
}, 15_000);

it('Sol proof, criterion 7: under one cent left is the cap, never `--max-budget-usd 0.00`', async () => {
  const { w, r } = await start();
  w.write('ledger.jsonl', `${JSON.stringify({ costUsd: 9.995 })}\n`);
  const reply = await call(r);
  expect(reply?.['code']).toBe('LOCAL_CAP_REACHED');
  expect(w.calls('hey')).toHaveLength(0);
}, 15_000);

it('Sol proof, path: a relative OPS_LOCAL_AGENT_HOME is refused', () => {
  world = makeWorld();
  const read = readSettings(
    { ...world.env, OPS_LOCAL_AGENT_HOME: 'relative/agent-home' },
    world.userHome,
  );
  expect(read.ok).toBe(false);
});
