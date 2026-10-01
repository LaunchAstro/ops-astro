// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the local runner's settings. It starts only on the owner's
// laptop (OPS_ENVIRONMENT=local), on a named seat, under a cap of USD 10 that
// only an approval raises.

import { afterEach, describe, expect, it } from 'vitest';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { makeWorld, type World } from './world.ts';

let world: World | undefined;
afterEach(() => {
  world?.remove();
  world = undefined;
});

const fresh = (): World => {
  world = makeWorld();
  return world;
};

describe('the local runner starts only on the laptop', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['staging', 'staging'],
    ['production', 'production'],
    ['hosted', 'hosted'],
    ['upper case', 'LOCAL'],
    ['padded', ' local'],
  ])('refuses to start when OPS_ENVIRONMENT is %s, by name', (_label, value) => {
    const w = fresh();
    const read = readSettings({ ...w.env, OPS_ENVIRONMENT: value }, w.userHome);
    expect(read).toMatchObject({ ok: false, code: 'LOCAL_ONLY' });
  });

  it('starts when OPS_ENVIRONMENT is local, on Haiku with a USD 10 cap', () => {
    const w = fresh();
    const read = readSettings(w.env, w.userHome);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.settings.capUsd).toBe(10);
    expect(read.settings.seat).toBe('hey');
    expect(read.settings.seatDir).toBe(w.seatDir('hey'));
  });
});

describe('the seat is a setting', () => {
  it.each([['other'], [''], ['../hey'], ['HEY']])('refuses the seat %j', (seat) => {
    const w = fresh();
    const read = readSettings({ ...w.env, OPS_LOCAL_AGENT_SEAT: seat }, w.userHome);
    expect(read).toMatchObject({ ok: false, code: 'LOCAL_SEAT_REFUSED' });
  });

  it('runs on the nathan seat when it is chosen', () => {
    const w = fresh();
    const read = readSettings({ ...w.env, OPS_LOCAL_AGENT_SEAT: 'nathan' }, w.userHome);
    expect(read.ok && read.settings.seatDir).toBe(w.seatDir('nathan'));
  });
});

describe('the cap', () => {
  it('refuses to start with a cap above USD 10 and no approval for it', () => {
    const w = fresh();
    const read = readSettings({ ...w.env, OPS_LOCAL_AGENT_CAP_USD: '30' }, w.userHome);
    expect(read).toMatchObject({ ok: false, code: 'CAP_NOT_APPROVED' });
  });

  it('refuses a cap above USD 10 whose approval names another amount', () => {
    const w = fresh();
    w.write('approvals.json', { capUsd: 20 });
    const read = readSettings({ ...w.env, OPS_LOCAL_AGENT_CAP_USD: '30' }, w.userHome);
    expect(read).toMatchObject({ ok: false, code: 'CAP_NOT_APPROVED' });
  });

  it('starts with a cap above USD 10 the approval names', () => {
    const w = fresh();
    w.write('approvals.json', { capUsd: 30 });
    const read = readSettings({ ...w.env, OPS_LOCAL_AGENT_CAP_USD: '30' }, w.userHome);
    expect(read.ok && read.settings.capUsd).toBe(30);
  });

  it.each([['ten'], ['-1'], ['0'], ['Infinity'], ['1e9']])('refuses the cap %j', (cap) => {
    const w = fresh();
    w.write('approvals.json', { capUsd: 1e9 });
    const read = readSettings({ ...w.env, OPS_LOCAL_AGENT_CAP_USD: cap }, w.userHome);
    expect(read.ok).toBe(false);
  });
});

describe('the runner key', () => {
  it.each([
    ['missing', undefined],
    ['short', 'abc'],
  ])('refuses to start with a %s key', (_l, key) => {
    const w = fresh();
    const read = readSettings({ ...w.env, OPS_LOCAL_AGENT_KEY: key }, w.userHome);
    expect(read).toMatchObject({ ok: false, code: 'KEY_REFUSED' });
  });

  it('never names the key or the planted canary in a refusal', () => {
    const w = fresh();
    const read = readSettings({ ...w.env, OPS_ENVIRONMENT: 'production' }, w.userHome);
    const text = JSON.stringify(read);
    expect(text).not.toContain(w.env['OPS_LOCAL_AGENT_KEY']);
    expect(text).not.toContain(w.env['ANTHROPIC_API_KEY']);
  });
});
