// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner's settings (LA-1, #859), read once at start from the
// environment. The runner exists so the owner can test the agent features on
// their own laptop, on their own Claude subscription, before any API spend.
// So it starts only where OPS_ENVIRONMENT is exactly `local`; anywhere else,
// unset included, it refuses by name and nothing listens.
//
// The seat is a setting, `hey` or `nathan` (no other seat holds a subscription today),
// and names the Claude Code folder `~/.claude-seat-<seat>` the call runs on.
// The cap is in API-equivalent US dollars, USD 10 unless the owner's approval
// in `approvals.json` names a higher one. A refusal names the setting, never
// its value: the runner key is one of them.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SEATS = ['hey', 'nathan'] as const;
export type Seat = (typeof SEATS)[number];

/** The cap with no approval: the owner's first figure (addendum 2). */
export const DEFAULT_CAP_USD = 10;
const MIN_KEY_LENGTH = 32;

export interface RunnerSettings {
  readonly key: string;
  readonly seat: Seat;
  /** The seat's Claude Code folder, passed to the child as CLAUDE_CONFIG_DIR. */
  readonly seatDir: string;
  /** The runner's own folder: the ledger, the approvals and the child's empty working folder. */
  readonly home: string;
  readonly capUsd: number;
  readonly claudeBin: string;
  /** The seat usage reading, `{ seat, percent, at }`, when the operator keeps one. */
  readonly usageFile: string | null;
  /** What the child inherits, and nothing else. */
  readonly childEnv: { readonly PATH: string; readonly HOME: string; readonly LANG: string };
  readonly timeoutMs: number;
}

export type StartRefusal =
  'LOCAL_ONLY' | 'LOCAL_SEAT_REFUSED' | 'KEY_REFUSED' | 'CAP_MALFORMED' | 'CAP_NOT_APPROVED';

export type SettingsResult =
  | { readonly ok: true; readonly settings: RunnerSettings }
  | { readonly ok: false; readonly code: StartRefusal; readonly message: string };

const refuse = (code: StartRefusal, message: string): SettingsResult => ({
  ok: false,
  code,
  message,
});

export interface Approvals {
  readonly capUsd: number | null;
  readonly models: readonly string[];
}

/** The owner's approvals, read fresh each time: a missing or unreadable file approves nothing. */
export function readApprovals(home: string): Approvals {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(home, 'approvals.json'), 'utf8'));
  } catch {
    return { capUsd: null, models: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { capUsd: null, models: [] };
  }
  const shape = parsed as Record<string, unknown>;
  const cap = shape['capUsd'];
  const models = shape['models'];
  return {
    capUsd: typeof cap === 'number' && Number.isFinite(cap) ? cap : null,
    models: Array.isArray(models)
      ? models.filter((model): model is string => typeof model === 'string')
      : [],
  };
}

/** A cap as the owner writes it: dollars and cents, above nothing. */
function capOf(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return DEFAULT_CAP_USD;
  if (!/^\d{1,5}(\.\d{1,2})?$/u.test(text)) return undefined;
  const cap = Number(text);
  return cap > 0 ? cap : undefined;
}

export function readSettings(
  env: Readonly<Record<string, string | undefined>>,
  userHome: string = homedir(),
): SettingsResult {
  if (env['OPS_ENVIRONMENT'] !== 'local') {
    return refuse('LOCAL_ONLY', 'the local runner starts only where OPS_ENVIRONMENT is local');
  }
  const seat = env['OPS_LOCAL_AGENT_SEAT'];
  if (!SEATS.some((known) => known === seat)) {
    return refuse('LOCAL_SEAT_REFUSED', 'set OPS_LOCAL_AGENT_SEAT to hey or nathan');
  }
  const key = env['OPS_LOCAL_AGENT_KEY'] ?? '';
  if (key.length < MIN_KEY_LENGTH) {
    return refuse(
      'KEY_REFUSED',
      `set OPS_LOCAL_AGENT_KEY, ${String(MIN_KEY_LENGTH)} characters or more`,
    );
  }
  const home = env['OPS_LOCAL_AGENT_HOME'] || join(userHome, '.ops-astro-local-agent');
  const capUsd = capOf(env['OPS_LOCAL_AGENT_CAP_USD']);
  if (capUsd === undefined) {
    return refuse('CAP_MALFORMED', 'OPS_LOCAL_AGENT_CAP_USD is a dollar amount above 0');
  }
  if (capUsd > DEFAULT_CAP_USD && readApprovals(home).capUsd !== capUsd) {
    return refuse(
      'CAP_NOT_APPROVED',
      `a cap above USD ${String(DEFAULT_CAP_USD)} needs the owner's yes in approvals.json`,
    );
  }
  return {
    ok: true,
    settings: {
      key,
      seat: seat as Seat,
      seatDir: join(userHome, `.claude-seat-${seat as Seat}`),
      home,
      capUsd,
      claudeBin: env['OPS_LOCAL_AGENT_CLAUDE_BIN'] || 'claude',
      usageFile: env['OPS_LOCAL_AGENT_SEAT_USAGE_FILE'] || null,
      childEnv: {
        PATH: env['PATH'] ?? '/usr/bin:/bin',
        HOME: userHome,
        LANG: env['LANG'] || 'en_AU.UTF-8',
      },
      timeoutMs: 120_000,
    },
  };
}
