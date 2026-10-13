// SPDX-License-Identifier: AGPL-3.0-only
//
// The GPT runner's install check certifies only what holds on the M5
// (docs/local/GPT-RUNNER.md): a credential file custody itself would load, and
// a runner's listeners read by a listener read that completed. A file custody
// refuses, or a listener read that is missing or fails, fails the check.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseCredentials } from '../../packages/core-custody/src/credentials.ts';
import { FAKE_CODEX, makeWorld, RUNNER_KEY, type World } from './world.ts';

const CHECK = resolve(import.meta.dirname, '../../scripts/m5/gpt-runner-install-check.sh');
let world: World | undefined;
afterEach(() => {
  world?.remove();
  world = undefined;
});

function installation(credentials: unknown, port?: number) {
  const w = makeWorld();
  world = w;
  chmodSync(w.agentHome, 0o700);
  chmodSync(w.codexHome, 0o700);
  const settingsFile = join(w.agentHome, 'settings.json');
  const credentialFile = join(w.agentHome, 'credentials.json');
  writeFileSync(
    settingsFile,
    JSON.stringify({
      OPS_LOCAL_AGENT_SITE: 'm5',
      OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1',
      OPS_LOCAL_AGENT_HOME: w.agentHome,
      OPS_LOCAL_AGENT_CODEX_BIN: FAKE_CODEX,
      OPS_LOCAL_AGENT_KEY: RUNNER_KEY,
      ...(port === undefined ? {} : { OPS_LOCAL_AGENT_PORT: String(port) }),
    }),
    { mode: 0o600 },
  );
  writeFileSync(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  return { w, settingsFile, credentialFile };
}

function checked(files: ReturnType<typeof installation>, path = process.env['PATH']) {
  return spawnSync('/bin/sh', [CHECK, files.settingsFile, files.credentialFile], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: path ?? '/usr/bin:/bin' },
  });
}

it('the install check refuses a credential file custody cannot load', () => {
  // Correct bearer, destination and key, but a subscription is explicitly non-storable.
  const credentials = [
    {
      ref: 'local_runner',
      kind: 'subscription',
      account: 'synthetic-plan',
      destination: 'local_gpt',
      header: 'authorization',
      value: RUNNER_KEY,
    },
  ];
  expect(parseCredentials(credentials)).toMatchObject({
    ok: false,
    code: 'CREDENTIAL_NOT_STORABLE',
  });
  const result = checked(installation(credentials));
  expect(result.error).toBeUndefined();
  expect(
    result.status,
    'custody refuses this file, so install preflight must refuse it too',
  ).not.toBe(0);
});

it('a failed listener inspection cannot certify a public listener as loopback', async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '0.0.0.0', done));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP listener');
    expect(address.address).toBe('0.0.0.0');
    const files = installation(
      [
        {
          ref: 'local_runner',
          kind: 'api_key',
          account: 'synthetic-plan',
          destination: 'local_gpt',
          header: 'authorization',
          value: RUNNER_KEY,
        },
      ],
      address.port,
    );
    const bin = join(files.w.agentHome, 'bin');
    mkdirSync(bin, { mode: 0o700 });
    symlinkSync(process.execPath, join(bin, 'node'));
    // A diagnostic failure differs from a successful inspection with no listeners.
    writeFileSync(join(bin, 'lsof'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
    const result = checked(files, bin);
    expect(result.error).toBeUndefined();
    expect(result.status, 'the check could not inspect a real public listener').not.toBe(0);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

const LOOPBACK_ONLY = [
  {
    ref: 'local_runner',
    kind: 'api_key',
    account: 'synthetic-plan',
    destination: 'local_gpt',
    header: 'authorization',
    value: RUNNER_KEY,
  },
];

it('the install check fails closed, with a plain message, when no listener read is installed', () => {
  const files = installation(LOOPBACK_ONLY, 1);
  const bin = join(files.w.agentHome, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  symlinkSync(process.execPath, join(bin, 'node'));
  const result = checked(files, bin);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    'gpt runner install check: the listeners on the runner’s port could not be read',
  );
});

it('the install check names the kind custody refuses, never a value', () => {
  const result = checked(installation([{ ...LOOPBACK_ONLY[0], kind: 'subscription' }]));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('custody refuses the credential file (CREDENTIAL_NOT_STORABLE)');
  expect(`${result.stdout}${result.stderr}`).not.toContain(RUNNER_KEY);
});

it('the install check passes a runner listening on loopback alone, and a port nothing listens on', async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP listener');
  try {
    const listening = checked(installation(LOOPBACK_ONLY, address.port));
    expect(listening.stdout).toContain('gpt runner install check: passed');
    expect(listening.status).toBe(0);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
  world?.remove();
  // lsof finds nothing on the closed port: a read that completed, not a failed one.
  const quiet = checked(installation(LOOPBACK_ONLY, address.port));
  expect(quiet.stdout).toContain('gpt runner install check: passed');
  expect(quiet.status).toBe(0);
});
