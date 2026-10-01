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
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * A file only the owner can read, written whole: a fresh temp file beside it
 * (never one already there, never through a symlink), renamed over the old
 * one. The rename replaces a symlink at `file` rather than following it.
 */
function writeOwnerFile(file: string, text: string): void {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** A value a sourced `export NAME='value'` line holds as it is. */
const QUOTABLE = /^[^'\n\r]*$/u;

/** `export NAME='value'` lines a shell can source; startStack refuses a value with a quote. */
function writeApiEnv(file: string, env: Readonly<Record<string, string>>): void {
  const lines = Object.entries(env).map(([name, value]) => `export ${name}='${value}'`);
  writeOwnerFile(file, `${lines.join('\n')}\n`);
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

/**
 * The tick's business, agent and worker for api.env, when OPS_LOCAL_AGENT_BUSINESS
 * names a made-up business the local seed has made; none asked for, none written.
 */
async function tickIdentity(
  env: Readonly<Record<string, string | undefined>>,
  identityOf: (env: Readonly<Record<string, string | undefined>>) => Promise<IdentityRead>,
): Promise<
  | { readonly ok: true; readonly env: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  if (!env['OPS_LOCAL_AGENT_BUSINESS']) return { ok: true, env: {} };
  const read = await identityOf(env);
  if (!read.ok) return read;
  return {
    ok: true,
    env: {
      OPS_LOCAL_AGENT_BUSINESS_ID: read.identity.businessId,
      OPS_LOCAL_AGENT_AGENT_SUBJECT: read.identity.agentSubject,
      OPS_LOCAL_AGENT_WORKER_ACTOR_ID: read.identity.workerActorId,
    },
  };
}

/** The one credential custody files for the broker: the runner's key. */
function credentialOf(seat: string, key: string) {
  return {
    ref: CREDENTIAL_REF,
    kind: 'api_key',
    account: `seat-${seat}`,
    destination: DESTINATION,
    header: 'authorization',
    value: key,
  };
}

// The runner takes the home before anything is written: a second start on a
// live home is refused with the filed key still the one the first runner serves.
async function claimHome(
  settings: Parameters<typeof createRunner>[0],
  print: (line: string) => void,
): Promise<{ ok: true; runner: Runner } | Extract<StackStart, { ok: false }>> {
  try {
    return { ok: true, runner: await createRunner(settings, print) };
  } catch (error) {
    if (String(error).includes('LOCAL_HOME_IN_USE')) {
      return {
        ok: false,
        code: 'LOCAL_HOME_IN_USE',
        message: 'another runner holds this OPS_LOCAL_AGENT_HOME',
      };
    }
    throw error;
  }
}

export async function startStack(
  env: Readonly<Record<string, string | undefined>>,
  userHome: string = homedir(),
  print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  identityOf: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<IdentityRead> = identityFromSeed,
): Promise<StackStart> {
  const key = env['OPS_LOCAL_AGENT_KEY'] || randomBytes(24).toString('hex');
  const read = readSettings({ ...env, OPS_LOCAL_AGENT_KEY: key }, userHome);
  if (!read.ok) return { ok: false, code: read.code, message: read.message };
  const { settings } = read;
  const tick = await tickIdentity(env, identityOf);
  if (!tick.ok) return tick;
  const installation = env['OPS_LOCAL_AGENT_INSTALLATION'] || 'local';
  if (!QUOTABLE.test(settings.home) || !QUOTABLE.test(installation)) {
    return {
      ok: false,
      code: 'SETTING_MALFORMED',
      message: 'OPS_LOCAL_AGENT_HOME and OPS_LOCAL_AGENT_INSTALLATION hold no quote or line break',
    };
  }
  mkdirSync(settings.home, { recursive: true, mode: 0o700 });
  // A home someone else owns could hold their symlinks or read the key.
  if (statSync(settings.home).uid !== process.getuid?.()) {
    return { ok: false, code: 'HOME_NOT_OWNED', message: 'OPS_LOCAL_AGENT_HOME is not yours' };
  }
  const claimed = await claimHome(settings, print);
  if (!claimed.ok) return claimed;
  const { runner } = claimed;
  const credentialsFile = join(settings.home, 'credentials.json');
  const apiEnvFile = join(settings.home, 'api.env');
  try {
    writeOwnerFile(credentialsFile, JSON.stringify([credentialOf(settings.seat, key)]));
    writeApiEnv(apiEnvFile, {
      ...apiEnvOf(runner.origin, credentialsFile, installation),
      ...tick.env,
    });
  } catch (error) {
    await runner.close();
    throw error;
  }
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
