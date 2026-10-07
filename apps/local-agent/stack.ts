// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1's one-command local stack (#859): `pnpm local-agent`.
//
// It refuses anywhere but OPS_ENVIRONMENT=local before it writes anything,
// and refuses while the runner's own Codex home is not signed in to the
// ChatGPT plan (an API-key login would bill per call). It makes a runner key
// when none is set, starts the runner, files that key for custody
// (`credentials.json`, 0600, destination `local_gpt`), and writes `api.env`
// (0600): the settings the owner sources before starting the API, so its
// broker runs on `local-gpt` against this runner. The key goes only into the
// credentials file; nothing prints it.

import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_GPT_PROVIDER } from '../../packages/core-connectors/src/index.ts';
import { codexLogin } from './codex.ts';
import { createRunner, type Runner } from './runner.ts';
import { readSettings, type RunnerSettings } from './settings.ts';

export interface Stack {
  readonly home: string;
  readonly runner: Runner;
  readonly credentialsFile: string;
  readonly apiEnvFile: string;
  close(): Promise<void>;
}

type Refusal = { readonly ok: false; readonly code: string; readonly message: string };

export type StackStart = { readonly ok: true; readonly stack: Stack } | Refusal;

const CREDENTIAL_REF = 'local_runner';

/** The API's settings for a broker on `local-gpt` against this runner. */
function apiEnvOf(origin: string, credentialsFile: string, installation: string) {
  const route = {
    key: LOCAL_GPT_PROVIDER,
    // GPT is a cloud model wherever its runner listens; the broker refuses it labelled local.
    reach: 'cloud',
    provider: LOCAL_GPT_PROVIDER,
    credentialRef: CREDENTIAL_REF,
    credentialKind: 'subscription',
    installation,
    ceiling: 2,
  };
  return {
    OPS_ENVIRONMENT: 'local',
    OPS_AGENT_PROVIDER: 'local-gpt',
    MODEL_BROKER_CREDENTIALS_FILE: credentialsFile,
    MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: LOCAL_GPT_PROVIDER, origin }]),
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

/** The one credential custody files for the broker: the runner's key. */
function credentialOf(key: string) {
  return {
    ref: CREDENTIAL_REF,
    kind: 'api_key',
    account: 'chatgpt-plan',
    destination: LOCAL_GPT_PROVIDER,
    header: 'authorization',
    value: key,
  };
}

// The runner takes the home before anything is written: a second start on a
// live home is refused with the filed key still the one the first runner serves.
async function claimHome(
  settings: RunnerSettings,
  port: number,
  print: (line: string) => void,
): Promise<{ readonly ok: true; readonly runner: Runner } | Refusal> {
  try {
    return { ok: true, runner: await createRunner(settings, print, port) };
  } catch (error) {
    if (!String(error).includes('LOCAL_HOME_IN_USE')) throw error;
    return {
      ok: false,
      code: 'LOCAL_HOME_IN_USE',
      message: 'another runner holds this OPS_LOCAL_AGENT_HOME',
    };
  }
}

/** Everything checked before the home is claimed: the settings, the home and the login. */
async function ready(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  userHome: string,
): Promise<
  { readonly ok: true; readonly settings: RunnerSettings; readonly port: number } | Refusal
> {
  const read = readSettings({ ...env, OPS_LOCAL_AGENT_KEY: key }, userHome);
  if (!read.ok) return { ok: false, code: read.code, message: read.message };
  const { settings } = read;
  const installation = env['OPS_LOCAL_AGENT_INSTALLATION'] || 'local';
  if (![settings.home, installation].every((value) => QUOTABLE.test(value))) {
    return {
      ok: false,
      code: 'SETTING_MALFORMED',
      message: 'OPS_LOCAL_AGENT_HOME and OPS_LOCAL_AGENT_INSTALLATION hold no quote or line break',
    };
  }
  const port = Number(env['OPS_LOCAL_AGENT_PORT'] ?? '0');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    return {
      ok: false,
      code: 'SETTING_MALFORMED',
      message: 'OPS_LOCAL_AGENT_PORT is a port number',
    };
  }
  // Nothing is made before the login is checked; a home not there yet holds no login.
  const before = homeRefusal(settings.home, false);
  if (before !== null) return before;
  if (!(await codexLogin(settings))) {
    return {
      ok: false,
      code: 'CODEX_NOT_SIGNED_IN',
      message: `sign the runner's Codex home in to ChatGPT once: mkdir -p -m 700 '${settings.home}' '${settings.codexHome}' && CODEX_HOME='${settings.codexHome}' codex login`,
    };
  }
  // Checked again once signed in: the key is filed in this home next, as it stands now.
  const after = homeRefusal(settings.home, true);
  if (after !== null) return after;
  return { ok: true, settings, port };
}

/** Why the runner's home cannot hold the key, or null; a home not there passes only before the login. */
function homeRefusal(path: string, mustExist: boolean): Refusal | null {
  const home = statSync(path, { throwIfNoEntry: false });
  if (home === undefined) {
    return mustExist
      ? { ok: false, code: 'HOME_NOT_OWNED', message: 'OPS_LOCAL_AGENT_HOME is not there' }
      : null;
  }
  // A home someone else owns could hold their symlinks or read the key.
  if (home.uid !== process.getuid?.()) {
    return { ok: false, code: 'HOME_NOT_OWNED', message: 'OPS_LOCAL_AGENT_HOME is not yours' };
  }
  // In a home others can write to, they could rename their own api.env over the one the owner sources.
  if ((home.mode & 0o022) !== 0) {
    return {
      ok: false,
      code: 'HOME_NOT_PRIVATE',
      message: 'others can write to OPS_LOCAL_AGENT_HOME: chmod 700 it',
    };
  }
  return null;
}

export async function startStack(
  env: Readonly<Record<string, string | undefined>>,
  userHome: string = homedir(),
  print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<StackStart> {
  const key = env['OPS_LOCAL_AGENT_KEY'] || randomBytes(24).toString('hex');
  const checked = await ready(env, key, userHome);
  if (!checked.ok) return checked;
  const { settings, port } = checked;
  const claimed = await claimHome(settings, port, print);
  if (!claimed.ok) return claimed;
  const { runner } = claimed;
  const credentialsFile = join(settings.home, 'credentials.json');
  const apiEnvFile = join(settings.home, 'api.env');
  const installation = env['OPS_LOCAL_AGENT_INSTALLATION'] || 'local';
  try {
    writeOwnerFile(credentialsFile, JSON.stringify([credentialOf(key)]));
    writeApiEnv(apiEnvFile, apiEnvOf(runner.origin, credentialsFile, installation));
  } catch (error) {
    await runner.close();
    throw error;
  }
  print(`local agent: runner on ${runner.origin}`);
  // The API and custody read the port and key only when they start.
  print(`local agent: source ${apiEnvFile}, then start or restart the API (pnpm api:up)`);
  print('local agent: after every launcher start, re-source it and restart the API');
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
