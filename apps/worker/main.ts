// SPDX-License-Identifier: AGPL-3.0-only
//
// The worker process: `pnpm worker [--once]`.
//
// Configuration comes from the environment, under the names the command line
// reads (`apps/cli/main.ts`): the API's address, the business key, the agent's
// own login (its email and password from custody, the sign-in service's
// address and publishable key) and the delegation it proposes under. It signs
// in itself and keeps that sign-in renewed (`sign-in.ts`). Nothing here reads a
// database address, and nothing prints a credential. Without `--once` it polls
// the API until its one proposal is made, then until a person's approval lets it
// apply that proposal once (T2c2), then exits; `--once` tries once.
//
// After each pass the API answered, it pings `OPS_WORKER_HEARTBEAT_URL` (no more
// often than `OPS_HEARTBEAT_EVERY_MS` when that is set), the
// watcher's heartbeat (S0-2): a pass with no answer, a fault or a refusal pings
// nothing, so a stopped or broken worker goes quiet and the watcher mails.
// And a worker whose credentials the API keeps refusing ends: after
// `REFUSED_IN_A_ROW` such passes it exits 1 with one line naming the setting,
// never its value, so compose shows a restart loop instead of a quiet "Up".

import { httpTransport, shownAddress, unredirected, type Transport } from '../cli/client.ts';
import { EVERY, heartbeatEvery, offEgress, paced, ping, UNREACHABLE } from './heartbeat.ts';
import { agentSignIn } from './sign-in.ts';
import { SYNTHETIC_USAGE } from './usage.ts';
import { createWorker, type WorkerOutcome } from './worker.ts';

const EXIT = { ok: 0, refused: 1, usage: 2, fault: 4 } as const;
const REQUIRED = [
  'OPS_ASTRO_BUSINESS',
  'OPS_ASTRO_EMAIL',
  'OPS_ASTRO_PASSWORD',
  'OPS_ASTRO_GOTRUE_URL',
  'OPS_ASTRO_DELEGATION',
] as const;
const PROVIDER_KEY = 'SUPABASE_PUBLISHABLE_KEY';
const AUTH_EGRESS = 'OPS_EGRESS_AUTH_HOST';
const HEARTBEAT = 'OPS_WORKER_HEARTBEAT_URL';
const HEARTBEAT_EGRESS = 'OPS_EGRESS_HEARTBEAT_HOST';
const API = 'OPS_ASTRO_API_URL';
const INTERVAL = 'OPS_ASTRO_WORKER_INTERVAL_MS';

export type WorkerSetting =
  | (typeof REQUIRED)[number]
  | typeof PROVIDER_KEY
  | typeof API
  | typeof INTERVAL
  | typeof HEARTBEAT
  | typeof HEARTBEAT_EGRESS
  | typeof AUTH_EGRESS
  | typeof EVERY;

/** Every setting the worker reads: the required ones, then the optional ones. */
export const WORKER_SETTINGS: readonly WorkerSetting[] = [
  ...REQUIRED,
  PROVIDER_KEY,
  API,
  INTERVAL,
  HEARTBEAT,
  HEARTBEAT_EGRESS,
  AUTH_EGRESS,
  EVERY,
];

/** How many passes in a row may refuse its credentials before it exits. */
const REFUSED_IN_A_ROW = 10;

/** The credential refusals that end it, each with the line naming what to check. */
const SETTING_REFUSED: Readonly<Record<string, string>> = {
  AUTH_SESSION_EXPIRED:
    'the API no longer accepts its sign-in; check OPS_ASTRO_EMAIL and OPS_ASTRO_PASSWORD',
  AUTH_UNKNOWN_LOGIN:
    'the API does not know its login; check OPS_ASTRO_EMAIL and OPS_ASTRO_PASSWORD',
  DELEGATION_NOT_LIVE: 'its delegation is no longer live; OPS_ASTRO_DELEGATION needs a new one',
};

/** How the worker reaches the API and the sign-in service; a test hands its own. */
export interface Reach {
  readonly transport: (api: string) => Transport;
  /** The fetch its sign-in goes over: one that follows no redirect. */
  readonly signIn: typeof fetch;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** What is wrong with the settings, in words naming each, never a value. */
function refusal(env: Environment): string | undefined {
  const missing = REQUIRED.filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) return `set ${missing.join(', ')}`;
  const heartbeat = env[HEARTBEAT];
  const url = URL.parse(heartbeat ?? '');
  if (heartbeat && (url?.protocol !== 'https:' || UNREACHABLE.test(url.hostname))) {
    return `${HEARTBEAT} must be a public https address`;
  }
  const every = heartbeatEvery(env);
  if (typeof every === 'string') return every;
  // A deployment that lists the sign-in service's host holds the address to it.
  const signIn = env[AUTH_EGRESS] ? [['OPS_ASTRO_GOTRUE_URL', AUTH_EGRESS] as const] : [];
  return offEgress(env, [[HEARTBEAT, HEARTBEAT_EGRESS], ...signIn]);
}

const REACH: Reach = { transport: httpTransport, signIn: unredirected };

/** A renewal GoTrue refused, in its own words, which never carry the password. */
const renewalFailed = (because: string): void => {
  process.stderr.write(`worker: signing in again failed: ${because}\n`);
};

/** The worker, signed in as its agent; or the exit code once the line saying why is written. */
async function signedInWorker(
  env: Environment,
  api: string,
  reach: Reach,
): Promise<ReturnType<typeof createWorker> | number> {
  const login = {
    gotrueUrl: env['OPS_ASTRO_GOTRUE_URL'] as string,
    email: env['OPS_ASTRO_EMAIL'] as string,
    password: env['OPS_ASTRO_PASSWORD'] as string,
    providerKey: env[PROVIDER_KEY] ?? '',
  };
  const signedIn = await agentSignIn(login, renewalFailed, reach.signIn);
  if ('because' in signedIn) {
    process.stderr.write(`worker: could not sign in as OPS_ASTRO_EMAIL: ${signedIn.because}\n`);
    return EXIT.refused;
  }
  return createWorker({
    transport: reach.transport(api),
    businessKey: env['OPS_ASTRO_BUSINESS'] as string,
    credential: signedIn,
    delegation: env['OPS_ASTRO_DELEGATION'] as string,
    reporter: SYNTHETIC_USAGE,
  });
}

/**
 * Counts the passes in a row that refused its credentials; at the limit,
 * writes the line naming the setting to check and answers true.
 */
function credentialWatch(): (outcome: WorkerOutcome | undefined) => boolean {
  let inARow = 0;
  return (outcome) => {
    const check =
      outcome && 'refused' in outcome ? SETTING_REFUSED[outcome.refused.code] : undefined;
    inARow = check === undefined ? 0 : inARow + 1;
    if (inARow >= REFUSED_IN_A_ROW) process.stderr.write(`worker: ${check}\n`);
    return inARow >= REFUSED_IN_A_ROW;
  };
}

export async function main(
  argv: readonly string[],
  env: Environment,
  beat: (address: string | undefined) => Promise<string> = ping,
  reach: Reach = REACH,
): Promise<number> {
  const refused = refusal(env);
  if (refused !== undefined) {
    process.stderr.write(`worker: ${refused}\n`);
    return EXIT.usage;
  }
  const api = (env[API] ?? 'http://127.0.0.1:8790').replace(/\/$/u, '');
  const worker = await signedInWorker(env, api, reach);
  if (typeof worker === 'number') return worker;
  const pacedBeat = paced(Number(heartbeatEvery(env)), beat);
  const tooOften = credentialWatch();
  const interval = Number(env[INTERVAL] ?? 5_000);
  let proposedOn: string | undefined;
  for (;;) {
    let outcome: Awaited<ReturnType<typeof worker.proposeOnce>> | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one poll at a time, by design
      outcome = await (proposedOn === undefined
        ? worker.proposeOnce()
        : worker.applyOnce(proposedOn));
    } catch {
      // The failure's own text is never printed: a transport error can carry
      // the request, and the request carries both credentials (T2 canary token).
      process.stderr.write(`worker: no answer from ${shownAddress(api)}\n`);
    }
    if (outcome !== undefined) process.stdout.write(`${JSON.stringify(outcome)}\n`);
    if (outcome !== undefined && 'proposed' in outcome) proposedOn = outcome.proposed.taskId;
    if (tooOften(outcome)) return EXIT.refused;
    // oxlint-disable-next-line no-await-in-loop -- one ping per pass the API answered
    if (outcome && !('fault' in outcome || 'refused' in outcome)) await pacedBeat(env[HEARTBEAT]);
    const settled = outcome !== undefined && 'applied' in outcome;
    if (argv.includes('--once') || settled) {
      if (outcome === undefined) return EXIT.fault;
      const ended = ['proposed', 'applied', 'idle', 'dropped'].some((key) => key in outcome);
      if (ended) return EXIT.ok;
      return 'refused' in outcome ? EXIT.refused : EXIT.fault;
    }
    // oxlint-disable-next-line no-await-in-loop -- the poll interval
    await new Promise<void>((done) => {
      setTimeout(done, interval);
    });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
