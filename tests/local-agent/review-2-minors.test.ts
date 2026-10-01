// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859), Opus review 2's minors fixed by the lead (R/local-agent/REVIEW-2.md
// M1, M6): the cap's ceiling, and api.env values a shell holds as they are.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { decide } from '../../apps/local-agent/gate.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { startStack } from '../../apps/local-agent/stack.ts';
import { makeWorld, type World } from './world.ts';

let world: World | undefined;
const quiet = (): void => {};

afterEach(() => {
  world?.remove();
  world = undefined;
});

it('a hand-written approval above USD 30 lifts the cap to 30 and no further', () => {
  world = makeWorld();
  world.write('approvals.json', { capUsd: 1000, models: [] });
  world.write('ledger.jsonl', `${JSON.stringify({ costUsd: 29.995 })}\n`);
  const read = readSettings(world.env, world.userHome);
  if (!read.ok) throw new Error(read.code);
  expect(decide(read.settings, 'haiku')).toEqual({ ok: false, code: 'LOCAL_CAP_REACHED' });
});

it('a configured cap above USD 30 is refused even when approvals.json names it', () => {
  world = makeWorld();
  world.write('approvals.json', { capUsd: 1000, models: [] });
  const read = readSettings({ ...world.env, OPS_LOCAL_AGENT_CAP_USD: '1000' }, world.userHome);
  expect(read.ok ? 'ok' : read.code).toBe('CAP_NOT_APPROVED');
});

it('an approval with no configured cap is the cap from the next call on', () => {
  world = makeWorld();
  world.write('ledger.jsonl', `${JSON.stringify({ costUsd: 12 })}\n`);
  const read = readSettings(world.env, world.userHome);
  if (!read.ok) throw new Error(read.code);
  expect(decide(read.settings, 'haiku')).toEqual({ ok: false, code: 'LOCAL_CAP_REACHED' });
  world.write('approvals.json', { capUsd: 30, models: [] });
  expect(decide(read.settings, 'haiku')).toEqual({ ok: true, budgetLeftUsd: 18 });
});

it('an installation name with a quote is refused before anything is written', async () => {
  world = makeWorld();
  const started = await startStack(
    { ...world.env, OPS_LOCAL_AGENT_INSTALLATION: "local'; touch pwned; '" },
    world.userHome,
    quiet,
  );
  expect(started.ok ? 'ok' : started.code).toBe('SETTING_MALFORMED');
  expect(existsSync(join(world.agentHome, 'api.env'))).toBe(false);
  expect(existsSync(join(world.agentHome, 'credentials.json'))).toBe(false);
});
