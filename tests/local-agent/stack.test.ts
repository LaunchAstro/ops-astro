// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the one-command local stack. It starts the runner, files the
// runner's key for custody, and writes the API's settings to source; it refuses
// outside OPS_ENVIRONMENT=local before writing anything, and never prints the
// key. The fake `claude` binary stands in for the real one.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { brokerSettings } from '../../apps/api/model-broker.ts';
import { readApiEnv, startStack, type Stack } from '../../apps/local-agent/stack.ts';
import { makeWorld, RUNNER_KEY, type World } from './world.ts';

let world: World | undefined;
let stack: Stack | undefined;
const printed: string[] = [];
const print = (line: string): void => {
  printed.push(line);
};

afterEach(async () => {
  await stack?.close();
  stack = undefined;
  world?.remove();
  world = undefined;
  printed.length = 0;
});

async function started(overrides: Record<string, string | undefined> = {}): Promise<Stack> {
  world = makeWorld();
  const result = await startStack({ ...world.env, ...overrides }, world.userHome, print);
  if (!result.ok) throw new Error(`stack refused: ${result.code}`);
  stack = result.stack;
  return result.stack;
}

it.each([['staging'], ['production'], [undefined]])(
  'the stack refuses outside OPS_ENVIRONMENT=local (%s) and writes nothing',
  async (environment) => {
    world = makeWorld();
    const result = await startStack(
      { ...world.env, OPS_ENVIRONMENT: environment },
      world.userHome,
      print,
    );
    expect(result).toMatchObject({ ok: false, code: 'LOCAL_ONLY' });
    expect(existsSync(world.agentHome)).toBe(false);
  },
);

it("the API settings it writes parse through the broker's own reader as local-claude", async () => {
  const s = await started();
  const env = readApiEnv(readFileSync(s.apiEnvFile, 'utf8'));
  expect(env['OPS_ENVIRONMENT']).toBe('local');
  expect(env['OPS_AGENT_PROVIDER']).toBe('local-claude');
  const settings = brokerSettings(env);
  expect(settings).toMatchObject({ kind: 'configured', provider: 'local-claude' });
  if (settings.kind !== 'configured') return;
  expect(settings.routes).toEqual([
    expect.objectContaining({
      key: 'local_claude',
      reach: 'local',
      provider: 'local_claude',
      credentialKind: 'subscription',
    }),
  ]);
  expect(settings.custody.destinations).toEqual([
    expect.objectContaining({ key: 'local_claude', origin: s.runner.origin }),
  ]);
});

it("the credentials file is the owner's alone and holds the runner key, which is never printed", async () => {
  const s = await started();
  expect(statSync(s.credentialsFile).mode & 0o777).toBe(0o600);
  expect(statSync(s.apiEnvFile).mode & 0o777).toBe(0o600);
  const [credential] = JSON.parse(readFileSync(s.credentialsFile, 'utf8')) as Record<
    string,
    unknown
  >[];
  expect(credential).toMatchObject({
    ref: 'local_runner',
    kind: 'api_key',
    account: 'seat-hey',
    destination: 'local_claude',
    header: 'authorization',
    value: RUNNER_KEY,
  });
  expect(printed.join('\n')).not.toContain(RUNNER_KEY);
  expect(printed.join('\n')).toContain(s.runner.origin);
});

it('a key is made when none is set, filed for custody and never printed', async () => {
  const s = await started({ OPS_LOCAL_AGENT_KEY: undefined });
  const [credential] = JSON.parse(readFileSync(s.credentialsFile, 'utf8')) as {
    value: string;
  }[];
  expect(credential?.value).toMatch(/^[0-9a-f]{48}$/u);
  expect(printed.join('\n')).not.toContain(credential?.value);
});

it('a call through the started runner, with the filed key, is answered', async () => {
  const s = await started();
  const [credential] = JSON.parse(readFileSync(s.credentialsFile, 'utf8')) as {
    value: string;
  }[];
  const response = await fetch(`${s.runner.origin}/v1/local-claude/complete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credential?.value ?? ''}`,
    },
    body: JSON.stringify({ fields: { message: 'Is the local stack up?' } }),
  });
  const answer = (await response.json()) as Record<string, unknown>;
  expect(answer['code']).toBeNull();
  expect(typeof answer['text']).toBe('string');
  expect(world?.calls('hey')).toHaveLength(1);
  expect(existsSync(join(s.home, 'ledger.jsonl'))).toBe(true);
});
