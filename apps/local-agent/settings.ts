// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner's settings (LA-1, #859), read once at start from the
// environment. The runner exists so the owner can test the agent features on
// their own laptop, on their own ChatGPT plan through `codex exec`, before
// any API spend. So it starts only where OPS_ENVIRONMENT is exactly `local`;
// anywhere else, unset included, it refuses by name and nothing listens.
//
// The child runs on the runner's own Codex home, `<home>/codex`, never the
// owner's `~/.codex`: that one holds the owner's own instructions (AGENTS.md)
// and memories, which every call would read. The owner signs in to it once
// with `CODEX_HOME=<home>/codex codex login`; the runner never reads the login.
//
// The plan reports no dollar cost, so the cap counts tokens: 2,000,000 unless
// the owner's yes in `approvals.json` names a higher figure, 10,000,000 at
// most. A refusal names the setting, never its value: the runner key is one of them.

import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';

const MIN_KEY_LENGTH = 32;

/** The cap with no approval, in tokens in and out. */
export const DEFAULT_CAP_TOKENS = 2_000_000;
/** The highest cap the owner's yes can raise to. */
export const MAX_CAP_TOKENS = 10_000_000;

export interface RunnerSettings {
  readonly key: string;
  /** The runner's own folder: its Codex home, its ledger and the child's empty working folder. */
  readonly home: string;
  /** The child's CODEX_HOME: the runner's own login, and nothing of the owner's. */
  readonly codexHome: string;
  readonly codexBin: string;
  readonly capTokens: number;
  /**
   * OPS_LOCAL_AGENT_CAP_TOKENS was set: that figure is the cap, whatever
   * approvals.json says, except one above the default, which needs its yes kept (gate.ts).
   */
  readonly capConfigured: boolean;
  /** What the child inherits, and nothing else. */
  readonly childEnv: {
    readonly PATH: string;
    readonly HOME: string;
    readonly LANG: string;
    readonly USER: string;
    readonly LOGNAME: string;
  };
  readonly timeoutMs: number;
}

export type StartRefusal =
  'LOCAL_ONLY' | 'KEY_REFUSED' | 'HOME_NOT_ABSOLUTE' | 'CAP_MALFORMED' | 'CAP_NOT_APPROVED';

export type SettingsResult =
  | { readonly ok: true; readonly settings: RunnerSettings }
  | { readonly ok: false; readonly code: StartRefusal; readonly message: string };

const refuse = (code: StartRefusal, message: string): SettingsResult => ({
  ok: false,
  code,
  message,
});

export interface Approvals {
  readonly capTokens: number | null;
  readonly models: readonly string[];
}

/**
 * The owner's approvals, `{ "capTokens": n, "models": [...] }`, written by
 * hand and read fresh each time: a missing or unreadable file approves nothing.
 */
export function readApprovals(home: string): Approvals {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(home, 'approvals.json'), 'utf8'));
  } catch {
    return { capTokens: null, models: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { capTokens: null, models: [] };
  }
  const shape = parsed as Record<string, unknown>;
  const cap = shape['capTokens'];
  const models = shape['models'];
  return {
    capTokens: typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0 ? cap : null,
    models: Array.isArray(models)
      ? models.filter((model): model is string => typeof model === 'string')
      : [],
  };
}

/** A cap as the owner writes it: a whole number of tokens above nothing. */
function capOf(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return DEFAULT_CAP_TOKENS;
  if (!/^[1-9]\d{0,8}$/u.test(text)) return undefined;
  return Number(text);
}

/**
 * The only environment the codex child gets: nothing of the runner's own
 * settings or keys, and a HOME of the runner's own, so nothing the owner keeps
 * in their home (skills, keys, dotfiles) is read by a call.
 */
function childEnvOf(
  env: Readonly<Record<string, string | undefined>>,
  childHome: string,
): RunnerSettings['childEnv'] {
  const userName = env['USER'] || userInfo().username;
  return {
    PATH: env['PATH'] ?? '/usr/bin:/bin',
    HOME: childHome,
    LANG: env['LANG'] || 'en_AU.UTF-8',
    USER: userName,
    LOGNAME: userName,
  };
}

export function readSettings(
  env: Readonly<Record<string, string | undefined>>,
  userHome: string = homedir(),
): SettingsResult {
  if (env['OPS_ENVIRONMENT'] !== 'local') {
    return refuse('LOCAL_ONLY', 'the local runner starts only where OPS_ENVIRONMENT is local');
  }
  const key = env['OPS_LOCAL_AGENT_KEY'] ?? '';
  if (key.length < MIN_KEY_LENGTH) {
    return refuse(
      'KEY_REFUSED',
      `set OPS_LOCAL_AGENT_KEY, ${String(MIN_KEY_LENGTH)} characters or more`,
    );
  }
  const home = env['OPS_LOCAL_AGENT_HOME'] || join(userHome, '.ops-astro-local-agent');
  // A relative home moves the ledger with the working folder and can put the child in a repository.
  if (!isAbsolute(home)) {
    return refuse('HOME_NOT_ABSOLUTE', 'OPS_LOCAL_AGENT_HOME is an absolute path');
  }
  const capTokens = capOf(env['OPS_LOCAL_AGENT_CAP_TOKENS']);
  if (capTokens === undefined) {
    return refuse('CAP_MALFORMED', 'OPS_LOCAL_AGENT_CAP_TOKENS is a whole number of tokens');
  }
  const approved = readApprovals(home).capTokens;
  if (capTokens > MAX_CAP_TOKENS || (capTokens > DEFAULT_CAP_TOKENS && approved !== capTokens)) {
    return refuse(
      'CAP_NOT_APPROVED',
      `a cap above ${String(DEFAULT_CAP_TOKENS)} tokens needs the owner's yes in approvals.json, ` +
        `${String(MAX_CAP_TOKENS)} at most`,
    );
  }
  return {
    ok: true,
    settings: {
      key,
      home,
      codexHome: join(home, 'codex'),
      codexBin: env['OPS_LOCAL_AGENT_CODEX_BIN'] || 'codex',
      capTokens,
      capConfigured: (env['OPS_LOCAL_AGENT_CAP_TOKENS'] ?? '') !== '',
      childEnv: childEnvOf(env, join(home, 'home')),
      // Under custody's 120 s for the call, so the runner gives up first.
      timeoutMs: 100_000,
    },
  };
}
