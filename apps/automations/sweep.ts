// SPDX-License-Identifier: AGPL-3.0-only
//
// A6 (#1653): the scheduled occurrence sweep for a hosted installation, whose
// function entry starts no sweeper. launchd runs it every minute on the
// environment machine (`deploy/<env>/ops-astro-*occurrence-sweep.plist`).
// One invocation is one round of the API sweeper's `occurrenceRound`, then
// it exits.
//
//   node apps/automations/sweep.ts    (pnpm automations:sweep)
//
// `AUTOMATION_FIRING` anything but exactly `on`: it says firing is off and
// exits 0 before it reads any other setting or opens a connection. On, it
// needs the application login (`DATABASE_URL`), the lookup login
// (`DATABASE_LOOKUP_URL`) and the businesses to sweep
// (`AUTOMATION_BUSINESS_KEYS`, as `RECOVERY_BUSINESS_KEYS` is written), and
// refuses to start beside a login or key held elsewhere. Each business is
// swept in its own transaction as its own active worker; one with none is
// skipped. It prints one line of counts and no ids, and exits 1 when a
// business failed, a key naming no business included, or 2 on a settings
// problem, which names its setting, never a value.
//
// It runs no listener and no route: nothing a person or an agent sends
// reaches it. A run overlapping another, or repeated in the same minute,
// starts each run once through the claim's own uniqueness.

import {
  connect,
  connectAsAdmin,
  isBusinessId,
  type AdminConnection,
  type BusinessId,
} from '../../packages/core-records/src/index.ts';
import { HELD_ELSEWHERE } from '../api/held-elsewhere.ts';
import { occurrenceRound, type SweepOutcome } from '../api/occurrence-sweeper.ts';
import { parseRecoveryScope } from '../api/recovery-entry.ts';
import { createBusinessResolver } from '../api/server.ts';

export type Environment = Readonly<Record<string, string | undefined>>;

/** What one invocation prints, and its exit code. */
export interface SweepAnswer {
  readonly code: 0 | 1 | 2;
  readonly line: string;
}

const KEYS = 'AUTOMATION_BUSINESS_KEYS';

type SweepSettings =
  | {
      readonly ok: true;
      readonly databaseUrl: string;
      readonly lookupUrl: string;
      readonly keys: readonly string[];
    }
  | { readonly ok: false; readonly problem: string };

/** The settings read once firing is on, the mail unit's way. */
function sweepSettings(environment: Environment): SweepSettings {
  const value = (name: string): string => environment[name] ?? '';
  const held = HELD_ELSEWHERE.filter((name) => value(name) !== '');
  if (held.length > 0) {
    return {
      ok: false,
      problem: `${held.join(', ')} set: the sweep never holds a login or key held elsewhere`,
    };
  }
  const missing = ['DATABASE_URL', 'DATABASE_LOOKUP_URL'].filter((name) => value(name) === '');
  if (missing.length > 0) return { ok: false, problem: `not set: ${missing.join(', ')}` };
  const scope = parseRecoveryScope(environment[KEYS]);
  if (!scope.ok) {
    return { ok: false, problem: `${KEYS} must name business keys, comma separated, or none` };
  }
  return {
    ok: true,
    databaseUrl: value('DATABASE_URL'),
    lookupUrl: value('DATABASE_LOOKUP_URL'),
    keys: scope.keys,
  };
}

/** Each key to its business, as the lookup identity; one that resolves to none is counted. */
async function resolveKeys(
  lookup: AdminConnection,
  keys: readonly string[],
  failed: () => void,
): Promise<BusinessId[]> {
  const resolve = createBusinessResolver(lookup);
  const businesses: BusinessId[] = [];
  for (const key of keys) {
    // oxlint-disable-next-line no-await-in-loop -- one key at a time
    const id = await resolve(key).catch(() => null);
    if (typeof id === 'string' && isBusinessId(id)) businesses.push(id);
    else failed();
  }
  return businesses;
}

/** One round over the configured businesses, or firing off; every connection closed after. */
export async function sweepEntry(
  environment: Environment,
  options: { readonly now?: () => Date } = {},
): Promise<SweepAnswer> {
  if (environment['AUTOMATION_FIRING'] !== 'on') {
    return { code: 0, line: 'automation sweep: firing off' };
  }
  const settings = sweepSettings(environment);
  if (!settings.ok) return { code: 2, line: `automation sweep: ${settings.problem}` };
  const counts: Record<SweepOutcome, number> = { swept: 0, noWorker: 0, failed: 0 };
  const lookup = connectAsAdmin(settings.lookupUrl, { source: 'lookup' });
  const database = connect(settings.databaseUrl, { source: 'runtime' });
  try {
    const businesses = await resolveKeys(lookup, settings.keys, () => {
      counts.failed += 1;
    });
    await occurrenceRound(database, {
      businesses: async () => await Promise.resolve(businesses),
      ...(options.now === undefined ? {} : { now: options.now }),
      report: (outcome) => {
        counts[outcome] += 1;
      },
    })();
  } finally {
    await Promise.allSettled([lookup.close(), database.close()]);
  }
  return { code: counts.failed > 0 ? 1 : 0, line: JSON.stringify({ firing: 'on', ...counts }) };
}

// Only as the process's entry. An import, a test's included, sweeps nothing.
if (import.meta.main) {
  const { code, line } = await sweepEntry(process.env);
  if (code === 2) console.error(line);
  else console.log(line);
  process.exitCode = code;
}
