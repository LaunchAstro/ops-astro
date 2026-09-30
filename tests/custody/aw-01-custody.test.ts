// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01, the custody conformance proof: ten cases, each against custody's
// real process and the replay provider on loopback.
//
// Custody holds the key and injects it into a dispatch whose request was
// built elsewhere. Adapter code never runs in custody's process, no key is
// reachable from the broker's process or a worker, and no message returns a
// credential. `AW-01 canary` runs here too, at the process level, and
// `AW-01 hostile provider` in aw-01-custody-hostile.test.ts; their money half
// is in `tests/broker/`.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startCustody } from '../../packages/core-custody/src/index.ts';
import { openCustodyWorld, plantedKey, type CustodyWorld } from './custody-world.ts';

const ROOT = resolve(import.meta.dirname, '../..');

/** Tracked files naming a string, sorted; none is an empty list, not a failure. */
function gitGrep(needle: string, ...paths: string[]): readonly string[] {
  try {
    return execFileSync('git', ['grep', '-l', '-F', '-e', needle, '--', ...paths], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .toSorted();
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** Every module custody's process loads, by following its relative imports. */
function importGraph(entry: string): readonly string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"`]([^'"`]+)['"`]/gu)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier));
      else seen.add(specifier);
    }
  };
  visit(entry);
  return [...seen].map((file) => file.replace(`${ROOT}/`, ''));
}

let world: CustodyWorld;

beforeAll(async () => {
  world = await openCustodyWorld();
});

afterAll(async () => {
  await world?.close();
});

it('AW-01 custody 1: custody injects the key into the dispatch it did not build', async () => {
  world.provider.mode('answer');
  const before = world.provider.seen.length;
  const outcome = await world.custody.dispatch('replay_key', world.request());
  expect(outcome.kind).toBe('answered');
  expect(world.provider.seen.length).toBe(before + 1);
  expect(world.provider.seen.at(-1)?.authorization).toBe(`Bearer ${world.canary}`);
  if (outcome.kind !== 'answered') return;
  expect(outcome.credentialKind).toBe('api_key');
  expect(outcome.account).toBe('replay-account-1');
});

it("AW-01 custody 2: the broker's process never holds the key", async () => {
  world.provider.mode('answer');
  const outcome = await world.custody.dispatch('replay_key', world.request());
  expect(JSON.stringify(outcome)).not.toContain(world.canary);
  expect(JSON.stringify(process.env)).not.toContain(world.canary);
  // The request the broker built carries no credential and no origin.
  expect(JSON.stringify(world.request())).not.toContain(world.canary);
  expect(JSON.stringify(world.request())).not.toContain(world.provider.origin);
});

it('AW-01 custody 3: a provider echoing the key back is redacted before the answer leaves custody', async () => {
  world.provider.mode('echo_credential');
  const outcome = await world.custody.dispatch('replay_key', world.request());
  expect(outcome.kind).toBe('answered');
  expect(JSON.stringify(outcome)).not.toContain(world.canary);
  expect(JSON.stringify(outcome)).toContain('[redacted]');
});

it('AW-01 custody 4: no borrow path, and a key is sent only to its own destination', async () => {
  for (const type of ['credential', 'get', 'borrow', 'export', 'lease', 'DISPATCH']) {
    // eslint-disable-next-line no-await-in-loop
    const reply = await world.custody.raw({ type, credentialRef: 'replay_key' });
    expect(reply['code']).toBe('CUSTODY_UNKNOWN_REQUEST');
    expect(JSON.stringify(reply)).not.toContain(world.canary);
  }
  const before = world.provider.seen.length;
  const elsewhere = await world.custody.dispatch(
    'replay_key',
    world.request({ destination: 'another' }),
  );
  expect(elsewhere).toEqual({
    kind: 'refused',
    started: false,
    code: 'CUSTODY_CREDENTIAL_UNKNOWN',
  });
  const unknown = await world.custody.dispatch('no_such_key', world.request());
  expect(unknown).toEqual({
    kind: 'refused',
    started: false,
    code: 'CUSTODY_CREDENTIAL_UNKNOWN',
  });
  expect(world.provider.seen.length).toBe(before);
});

it('AW-01 custody 5: a subscription credential is never stored', async () => {
  const value = plantedKey();
  const file = world.writeCredentials([
    {
      ref: 'mine',
      kind: 'subscription',
      account: 'a person',
      destination: 'replay',
      header: 'authorization',
      value,
    },
  ]);
  await expect(startCustody({ credentialsFile: file, destinations: [] })).rejects.toThrow(
    /did not start/u,
  );
});

it('AW-01 custody 6: a Claude.ai or ChatGPT session token is refused at load, and its value is never written', () => {
  for (const value of [`sk-ant-sid01-${plantedKey()}`, `sess-${plantedKey()}`]) {
    const file = world.writeCredentials([
      {
        ref: 'filed_as_key',
        kind: 'api_key',
        account: 'x',
        destination: 'replay',
        header: 'authorization',
        value,
      },
    ]);
    const output = (() => {
      try {
        execFileSync(process.execPath, [join(ROOT, 'packages/core-custody/src/custody-main.ts')], {
          env: { CUSTODY_CREDENTIALS_FILE: file, CUSTODY_DESTINATIONS: '[]' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return 'started';
      } catch (error) {
        const failed = error as { stderr: Buffer; status: number };
        return `${String(failed.status)} ${failed.stderr.toString('utf8')}`;
      }
    })();
    expect(output).toMatch(/^78 custody: credential 0 refused SESSION_TOKEN_REFUSED/u);
    expect(output).not.toContain(value);
  }
});

it('AW-01 custody 7: custody lost mid-dispatch answers worker_lost, fault ours, and nothing is sent twice', async () => {
  const lost = await openCustodyWorld();
  try {
    lost.provider.mode('slow');
    const pending = lost.custody.dispatch('replay_key', lost.request({ timeoutMs: 20_000 }));
    await expect.poll(() => lost.provider.seen.length, { timeout: 5_000 }).toBe(1);
    lost.custody.kill();
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'worker_lost', started: true, fault: 'ours' });
    const again = await lost.custody.dispatch('replay_key', lost.request());
    expect(again.kind).toBe('worker_lost');
    expect(again.started).toBe(false);
    expect(lost.provider.seen.length).toBe(1);
  } finally {
    await lost.close();
  }
});

it("AW-01 custody 8: custody's own output never carries the key, after every hostile answer", async () => {
  for (const mode of [
    'oversized',
    'redirect',
    'malformed',
    'planted',
    'echo_credential',
  ] as const) {
    world.provider.mode(mode);
    // eslint-disable-next-line no-await-in-loop
    await world.custody.dispatch('replay_key', world.request());
  }
  expect(world.custody.stderr()).not.toContain(world.canary);
});

it('AW-01 custody 9: adapter, connector and database code never load in the key-holding process', () => {
  const graph = importGraph(join(ROOT, 'packages/core-custody/src/custody-main.ts'));
  expect(graph).toContain('packages/core-custody/src/custody-main.ts');
  for (const module of graph) {
    expect(module).not.toMatch(
      /core-connectors|core-records|core-runtime|core-commands|apps\/|pg/u,
    );
  }
});

it('AW-01 custody 10: no key is reachable from a worker or a configuration file loaded outside custody', () => {
  expect(gitGrep('CUSTODY_CREDENTIALS_FILE', 'packages', 'apps')).toEqual([
    'packages/core-custody/src/custody-main.ts',
    'packages/core-custody/src/custody.ts',
  ]);
  expect(gitGrep('core-custody', 'apps/worker', 'apps/cli', 'apps/web')).toEqual([]);
});
