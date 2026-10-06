// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the local runner's settings. It starts only on the owner's
// laptop (OPS_ENVIRONMENT=local), with a runner key, on its own Codex home
// under an absolute runner home, never the owner's ~/.codex.

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
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

  it("starts when OPS_ENVIRONMENT is local, on its own Codex home, not the owner's", () => {
    const w = fresh();
    const read = readSettings(w.env, w.userHome);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.settings.codexHome).toBe(w.codexHome);
    expect(read.settings.codexHome).not.toBe(join(w.userHome, '.codex'));
  });

  it('defaults its home under the user home', () => {
    const w = fresh();
    const read = readSettings({ ...w.env, OPS_LOCAL_AGENT_HOME: undefined }, w.userHome);
    expect(read.ok && read.settings.codexHome).toBe(
      join(w.userHome, '.ops-astro-local-agent', 'codex'),
    );
  });

  it('refuses a relative OPS_LOCAL_AGENT_HOME', () => {
    const w = fresh();
    const read = readSettings({ ...w.env, OPS_LOCAL_AGENT_HOME: 'agent' }, w.userHome);
    expect(read).toMatchObject({ ok: false, code: 'HOME_NOT_ABSOLUTE' });
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
    expect(text).not.toContain(w.env['OPENAI_API_KEY']);
  });
});
