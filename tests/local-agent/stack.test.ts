// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 cut 3: the one-command local stack. It refuses off the laptop and
// while the runner's Codex home is not signed in to the ChatGPT plan, before
// anything is written; it files the runner key for custody only, 0600, never
// through a symlink, and writes the API's settings for a `local-gpt` broker
// that the composition root accepts as they stand.

import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brokerSettings } from '../../apps/api/model-broker.ts';
import { startStack, type Stack } from '../../apps/local-agent/stack.ts';
import { makeWorld, RUNNER_KEY, sourced, type World } from './world.ts';

const printed: string[] = [];
const stacks: Stack[] = [];
let world: World | undefined;
afterEach(async () => {
  printed.length = 0;
  await Promise.all(stacks.splice(0).map(async (stack) => await stack.close()));
  world?.remove();
  world = undefined;
});

const fresh = (): World => {
  world = makeWorld();
  return world;
};

async function start(w: World, overrides: Record<string, string | undefined> = {}) {
  const started = await startStack({ ...w.env, ...overrides }, w.userHome, (line) =>
    printed.push(line),
  );
  if (started.ok) stacks.push(started.stack);
  return started;
}

describe('what the stack refuses before writing anything', () => {
  it.each([
    ['off the laptop', { OPS_ENVIRONMENT: 'staging' }, {}, 'LOCAL_ONLY'],
    ['with no Codex login', {}, { login: 'none' }, 'CODEX_NOT_SIGNED_IN'],
    ['on an API-key login, which bills', {}, { login: 'apikey' }, 'CODEX_NOT_SIGNED_IN'],
    [
      'an installation with a quote',
      { OPS_LOCAL_AGENT_INSTALLATION: "it's" },
      {},
      'SETTING_MALFORMED',
    ],
  ])('refuses %s', async (_label, overrides, knobs, code) => {
    const w = fresh();
    w.knobs(knobs);
    expect(await start(w, overrides)).toMatchObject({ ok: false, code });
    expect(existsSync(join(w.agentHome, 'credentials.json'))).toBe(false);
    expect(existsSync(join(w.agentHome, 'api.env'))).toBe(false);
    expect(existsSync(join(w.agentHome, 'runner.lock'))).toBe(false);
  });
});

describe('a started stack', () => {
  it('files the runner key for custody alone, 0600, and prints it nowhere', async () => {
    const w = fresh();
    const started = await start(w);
    if (!started.ok) throw new Error(started.code);
    const { credentialsFile, apiEnvFile } = started.stack;
    expect(JSON.parse(readFileSync(credentialsFile, 'utf8'))).toEqual([
      {
        ref: 'local_runner',
        kind: 'api_key',
        account: 'chatgpt-plan',
        destination: 'local_gpt',
        header: 'authorization',
        value: RUNNER_KEY,
      },
    ]);
    expect(statSync(credentialsFile).mode & 0o777).toBe(0o600);
    expect(statSync(apiEnvFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(apiEnvFile, 'utf8')).not.toContain(RUNNER_KEY);
    expect(printed.join('\n')).not.toContain(RUNNER_KEY);
  });

  it('writes the settings the API accepts as a local-gpt broker against this runner', async () => {
    const w = fresh();
    const started = await start(w);
    if (!started.ok) throw new Error(started.code);
    const settings = brokerSettings(sourced(started.stack.apiEnvFile));
    expect(settings).toMatchObject({
      kind: 'configured',
      provider: 'local-gpt',
      routes: [{ provider: 'local_gpt', reach: 'local', credentialKind: 'subscription' }],
    });
    expect(sourced(started.stack.apiEnvFile)['MODEL_BROKER_DESTINATIONS']).toContain(
      started.stack.runner.origin,
    );
  });

  it('makes its own runner key when none is set, and never prints it', async () => {
    const w = fresh();
    const started = await start(w, { OPS_LOCAL_AGENT_KEY: undefined });
    if (!started.ok) throw new Error(started.code);
    const [filed] = JSON.parse(readFileSync(started.stack.credentialsFile, 'utf8')) as {
      value: string;
    }[];
    expect(filed?.value).toMatch(/^[0-9a-f]{48}$/u);
    expect(printed.join('\n')).not.toContain(filed?.value);
  });

  it('a second start on a live home is refused, the filed key still the one the runner serves', async () => {
    const w = fresh();
    const first = await start(w);
    if (!first.ok) throw new Error(first.code);
    const filed = readFileSync(first.stack.credentialsFile, 'utf8');
    const second = await start(w, { OPS_LOCAL_AGENT_KEY: `other-${RUNNER_KEY}` });
    expect(second).toMatchObject({ ok: false, code: 'LOCAL_HOME_IN_USE' });
    expect(readFileSync(first.stack.credentialsFile, 'utf8')).toBe(filed);
  });

  it('replaces a credentials file left at 0644, and never writes through a symlink there', async () => {
    const w = fresh();
    const elsewhere = join(w.userHome, 'elsewhere.json');
    writeFileSync(elsewhere, 'untouched');
    w.write('api.env', 'old');
    symlinkSync(elsewhere, join(w.agentHome, 'credentials.json'));
    const started = await start(w);
    if (!started.ok) throw new Error(started.code);
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched');
    expect(statSync(started.stack.credentialsFile).mode & 0o777).toBe(0o600);
    expect(statSync(started.stack.apiEnvFile).mode & 0o777).toBe(0o600);
  });
});
