// SPDX-License-Identifier: AGPL-3.0-only
//
// Reviewer proofs for LA-1 (#859), review 2, at 77e317bd3. Each fails at that
// head for the reason its finding names (R/local-agent/REVIEW-2.md). Unit
// level: the real stack and runner, the fake `claude` binary, no database.
// Apply as tests/local-agent/review-2-proofs.test.ts. No assertion prints a key.

import { chmodSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { decide } from '../../apps/local-agent/gate.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { startStack, type Stack } from '../../apps/local-agent/stack.ts';
import { makeWorld, RUNNER_KEY, type World } from './world.ts';

let world: World | undefined;
const stacks: Stack[] = [];
const quiet = (): void => {};

afterEach(async () => {
  for (const s of stacks.splice(0)) {
    // eslint-disable-next-line no-await-in-loop
    await s.close();
  }
  world?.remove();
  world = undefined;
});

async function stackOn(w: World, overrides: Record<string, string | undefined> = {}) {
  const result = await startStack({ ...w.env, ...overrides }, w.userHome, quiet);
  if (result.ok) stacks.push(result.stack);
  return result;
}

const keyIn = (file: string): string =>
  (JSON.parse(readFileSync(file, 'utf8')) as { value: string }[])[0]?.value ?? '';

// B1 ------------------------------------------------------------------------

it('Sol proof, criterion secrets: a credentials file left from an earlier run at 0644 is 0600 once it holds the runner key', async () => {
  world = makeWorld();
  world.write('credentials.json', '[]');
  const file = join(world.agentHome, 'credentials.json');
  chmodSync(file, 0o644);
  const started = await stackOn(world);
  expect(started.ok).toBe(true);
  expect(keyIn(file)).toBe(RUNNER_KEY);
  expect(statSync(file).mode & 0o777).toBe(0o600);
}, 15_000);

it('Sol proof, criterion secrets: a symlink at credentials.json never carries the runner key to the file it points at', async () => {
  world = makeWorld();
  world.write('placeholder', '');
  const outside = join(world.root, 'readable-by-others.json');
  writeFileSync(outside, '[]', { mode: 0o644 });
  chmodSync(outside, 0o644);
  symlinkSync(outside, join(world.agentHome, 'credentials.json'));
  await stackOn(world);
  expect(readFileSync(outside, 'utf8').includes(RUNNER_KEY)).toBe(false);
  expect(lstatSync(join(world.agentHome, 'credentials.json')).isSymbolicLink()).toBe(false);
}, 15_000);

// B2 ------------------------------------------------------------------------

it('Sol proof, races: a second stack start on a home a runner holds leaves the filed key the one that runner serves', async () => {
  world = makeWorld();
  // No key in the environment: each start makes its own, as the documented command does.
  const first = await stackOn(world, { OPS_LOCAL_AGENT_KEY: undefined });
  if (!first.ok) throw new Error(`first stack refused: ${first.code}`);
  const second = await stackOn(world, { OPS_LOCAL_AGENT_KEY: undefined }).catch(() => null);
  // The second start is refused (LOCAL_HOME_IN_USE), by result or by throw.
  expect(second?.ok ?? false).toBe(false);
  // A custody started now (the tick, or the API after a restart) reads this file.
  const filed = keyIn(first.stack.credentialsFile);
  const response = await fetch(`${first.stack.runner.origin}/v1/local-claude/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${filed}` },
    body: JSON.stringify({ fields: { message: 'Is the local stack still up?' } }),
  });
  expect(response.status).toBe(200);
}, 15_000);

// B3 ------------------------------------------------------------------------

it('Sol proof, criterion 7: a cap the owner configured below an earlier approval is still the cap', () => {
  world = makeWorld();
  // An earlier yes raised the cap to 30; today's run is configured at 5.
  world.write('approvals.json', { capUsd: 30, models: [] });
  world.write('ledger.jsonl', `${JSON.stringify({ costUsd: 6 })}\n`);
  const read = readSettings({ ...world.env, OPS_LOCAL_AGENT_CAP_USD: '5' }, world.userHome);
  if (!read.ok) throw new Error(read.code);
  expect(read.settings.capUsd).toBe(5);
  expect(decide(read.settings, 'haiku')).toEqual({ ok: false, code: 'LOCAL_CAP_REACHED' });
});
