// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1's one-command local stack (#859): `node apps/local-agent/stack.ts`.
//
// It refuses anywhere but OPS_ENVIRONMENT=local before it writes anything. It
// makes a runner key when none is set, starts the runner, files that key for
// custody (`credentials.json`, 0600, destination `local_claude`, the seat as
// its account), and writes `api.env` (0600): the settings the owner sources
// before starting the API, so its broker runs on `local-claude` against this
// runner. The key goes only into the credentials file; nothing prints it.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRunner, type Runner } from './runner.ts';
import { readSettings } from './settings.ts';
import { identityFromSeed, type IdentityRead } from './seed.ts';

export interface Stack {
  readonly home: string;
  readonly runner: Runner;
  readonly credentialsFile: string;
  readonly apiEnvFile: string;
  close(): Promise<void>;
}

export type StackStart =
  | { readonly ok: true; readonly stack: Stack }
  | { readonly ok: false; readonly code: string; readonly message: string };

const DESTINATION = 'local_claude';
const CREDENTIAL_REF = 'local_runner';

/** The API's settings for a broker on `local-claude` against this runner. */
function apiEnvOf(origin: string, credentialsFile: string, installation: string) {
  const route = {
    key: DESTINATION,
    reach: 'local',
    provider: DESTINATION,
    credentialRef: CREDENTIAL_REF,
    credentialKind: 'subscription',
    installation,
    ceiling: 2,
  };
  return {
    OPS_ENVIRONMENT: 'local',
    OPS_AGENT_PROVIDER: 'local-claude',
    MODEL_BROKER_CREDENTIALS_FILE: credentialsFile,
    MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: DESTINATION, origin }]),
    MODEL_BROKER_ROUTES: JSON.stringify([route]),
    MODEL_BROKER_INSTALLATION: installation,
  };
}

/** `export NAME='value'` lines a shell can source; no value holds a single quote. */
function writeApiEnv(file: string, env: Readonly<Record<string, string>>): void {
  const lines = Object.entries(env).map(([name, value]) => `export ${name}='${value}'`);
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

/** The settings back out of `api.env`, as the API would see them after sourcing it. */
export function readApiEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^export ([A-Z_]+)='([^']*)'$/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) env[match[1]] = match[2];
  }
  return env;
}

export async function startStack(
  env: Readonly<Record<string, string | undefined>>,
  userHome: string = homedir(),
  print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  _identityOf: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<IdentityRead> = identityFromSeed,
): Promise<StackStart> {
  const key = env['OPS_LOCAL_AGENT_KEY'] || randomBytes(24).toString('hex');
  const read = readSettings({ ...env, OPS_LOCAL_AGENT_KEY: key }, userHome);
  if (!read.ok) return { ok: false, code: read.code, message: read.message };
  const { settings } = read;
  mkdirSync(settings.home, { recursive: true });
  const credentialsFile = join(settings.home, 'credentials.json');
  const credential = {
    ref: CREDENTIAL_REF,
    kind: 'api_key',
    account: `seat-${settings.seat}`,
    destination: DESTINATION,
    header: 'authorization',
    value: key,
  };
  writeFileSync(credentialsFile, JSON.stringify([credential]), { mode: 0o600 });
  const runner = await createRunner(settings, print);
  const apiEnvFile = join(settings.home, 'api.env');
  const installation = env['OPS_LOCAL_AGENT_INSTALLATION'] || 'local';
  writeApiEnv(apiEnvFile, apiEnvOf(runner.origin, credentialsFile, installation));
  print(`local agent: runner on ${runner.origin} (seat ${settings.seat})`);
  print(`local agent: source ${apiEnvFile} before starting the API`);
  return {
    ok: true,
    stack: { home: settings.home, runner, credentialsFile, apiEnvFile, close: runner.close },
  };
}

if (import.meta.main) {
  const started = await startStack(process.env);
  if (!started.ok) {
    process.stdout.write(`${started.code}: ${started.message}\n`);
    process.exit(1);
  }
  const stop = (): void => {
    void started.stack.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
