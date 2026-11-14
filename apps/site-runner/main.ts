// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner process (`docs/local/SITE-RUNNER.md`): `node apps/site-runner/main.ts`, run
// by launchd on the M5 from a deployed main build
// (`deploy/m5/ops-astro-site-runner.plist`). It opens its own database login
// (TLS required), confirms its one configured site's holder is the business or
// a client of it, signs in as its own agent actor, starts custody with the two
// site destinations, and runs a pass every 15 s: the locate (`locate.ts`), then
// the claims (`runner.ts`), each on its own so a failure in one leaves the
// other and the heartbeat going. Locate only (`SITE_RUNNER_LOCATE_ONLY=1`)
// takes no claims and signs in nowhere, and custody routes nothing but reads.
// After each pass it pings its heartbeat, no more often than its settings
// file's pace, so a stopped or broken runner goes quiet. SIGTERM, which
// `launchctl bootout` sends, stops custody and the database and exits. Its
// settings come from one file only its owner can read (`settings.ts`).
// Nothing printed carries a password, a key, a bearer, a token or an address.

import { setTimeout as sleep } from 'node:timers/promises';
import { createCli, httpTransport, isRefusal, unredirected } from '../cli/client.ts';
import { agentSignIn } from '../worker/sign-in.ts';
import { paced, ping } from '../worker/heartbeat.ts';
import { pinnedTransport, systemResolver } from '../../packages/core-connectors/src/index.ts';
import { startCustody } from '../../packages/core-custody/src/index.ts';
import { connect, type BusinessId, type Database } from '../../packages/core-records/src/index.ts';
import { QueueUnread, queueClaims, type AgentCall } from './claims.ts';
import { holderRefuses } from './configured.ts';
import { locatePass } from './locate.ts';
import { chromiumAt } from './picture-browser.ts';
import { reviewCaptures, reviewPool, type Captured } from './review-captures.ts';
import { createSiteRunner, FOLLOW_EVERY_MS, type Claim, type Passed } from './runner.ts';
import { HOSTING_ORIGIN, readSettings, SOURCE_ORIGIN, type Settings } from './settings.ts';
import { custodySites, siteDestinations, type RunnerSites } from './sites.ts';

/** The agent's calls through the command line's own entry, settled to an `Answer`. */
function apiCall(settings: Settings, bearer: () => Promise<string>): AgentCall {
  const transport = httpTransport(settings.OPS_ASTRO_API_URL);
  return async (verb, body, pickup) => {
    const cli = createCli({
      entry: 'agent',
      businessKey: encodeURIComponent(settings.OPS_ASTRO_BUSINESS),
      credential: await bearer(),
      ...(pickup === undefined ? {} : { delegation: pickup }),
      transport,
    });
    const answer = await cli.run(verb, { operationId: crypto.randomUUID(), ...body });
    if (isRefusal(answer)) return { refused: String((answer.body as { code?: unknown }).code) };
    if (answer.status < 200 || answer.status >= 300) return { fault: true };
    const detail = (answer.body as { detail?: Record<string, unknown> } | undefined)?.detail;
    return { detail: detail ?? {} };
  };
}

/**
 * A renewal's refusal, as a fixed line: the sign-in server's own text can
 * echo the password, so none of it is printed. The runner keeps its current
 * bearer until it lapses.
 */
const renewalFailed = (): void => {
  console.error('site-runner: a sign-in renewal failed');
};

/** Signed in as the runner's agent, or a fixed line saying it was refused. */
async function signedIn(settings: Settings): Promise<AgentCall | string> {
  const login = {
    gotrueUrl: settings.OPS_ASTRO_GOTRUE_URL,
    email: settings.OPS_ASTRO_EMAIL,
    password: settings.OPS_ASTRO_PASSWORD,
    providerKey: settings.providerKey,
  };
  const bearer = await agentSignIn(login, renewalFailed, unredirected);
  return 'because' in bearer ? 'sign-in refused' : apiCall(settings, bearer.current);
}

/** The claims' runner: the queue through the agent's calls, a person task logged by its code. */
function claimsRunner(
  settings: Settings,
  db: Database,
  call: AgentCall,
  sites: RunnerSites,
): () => Promise<readonly Passed[]> {
  const business = settings.OPS_ASTRO_BUSINESS_ID as BusinessId;
  const claims = queueClaims(call, db, business);
  const raiseTask = async (claim: Claim, reason: string) => {
    console.error(`site-runner: raised ${reason} on task ${claim.taskId}`);
    await claims.raise(claim, reason);
  };
  const runner = createSiteRunner({
    db,
    business,
    site: settings.site,
    // Before a pickup an agent may ask nothing but the queue (`agent-envelope.ts`,
    // `BEFORE_PICKUP`), so its actor is the holder the API names in its own pickup
    // answer. Every run is on a claim, so it is read after that pickup.
    get actorId() {
      return claims.holder();
    },
    claims,
    sites,
    raiseTask,
    now: Date.now,
  });
  return async () => await runner.pass();
}

/** The runner on custody, the fence and its own database login, and how to stop them. */
async function hosted(settings: Settings, db: Database, call: AgentCall | undefined) {
  const business = settings.OPS_ASTRO_BUSINESS_ID as BusinessId;
  const custody = await startCustody({
    credentialsFile: settings.SITE_RUNNER_CREDENTIALS_FILE,
    destinations: siteDestinations(
      { source: SOURCE_ORIGIN, hosting: HOSTING_ORIGIN },
      settings.locateOnly,
    ),
  });
  const sites = custodySites(
    {
      custody,
      resolve: systemResolver,
      capture: {
        pool: { agencyPages: settings.pages, otherPages: [], closedPoolReviews: [] },
        resolve: systemResolver,
        transport: pinnedTransport(),
      },
      wait: async (ms) => await sleep(ms),
      now: Date.now,
    },
    settings.site,
  );
  const ports = sites.locate();
  const capture = {
    pool: reviewPool(settings.site, business),
    resolve: systemResolver,
    transport: pinnedTransport(),
  };
  const pass = passFor(settings.locateOnly, {
    locate: async () => await locatePass({ db, business, site: settings.site, ports }),
    ...(call === undefined
      ? {}
      : {
          claims: claimsRunner(settings, db, call, sites),
          captures: reviewCaptures({ call, db, business, capture, browserAt: chromiumAt }),
        }),
  });
  const stop = async () => {
    await custody.stop();
    await db.close();
  };
  return { pass, stop };
}

export interface Parts {
  readonly locate: () => Promise<readonly Passed[]>;
  /** Absent while locating only: no claim is taken. */
  readonly claims?: () => Promise<readonly Passed[]>;
  /** The review captures (`review-captures.ts`), after the corrections; absent while locating only. */
  readonly captures?: () => Promise<readonly Captured[]>;
}

/** The pass the host runs: locating only, neither the claims nor the captures are taken. */
export const passFor =
  (locateOnly: boolean, parts: Parts) => async (): Promise<readonly Passed[]> =>
    await everyPart(locateOnly ? { locate: parts.locate } : parts);

/**
 * One pass: the locate, then the claims, then the captures, each on its own. A part that fails
 * logs its fault's name and the others still run; when the locate and the claims both failed
 * the pass fails, so the heartbeat goes quiet. A queue the claims or the captures could not
 * read fails the pass whatever the rest did: a runner that can no longer read its work never
 * reads as healthy. The captures are spare work: they never keep a pass healthy, and any
 * fault of theirs (an unclaimed capture included) fails it.
 */
export async function everyPart({ locate, claims, captures }: Parts): Promise<readonly Passed[]> {
  const faults: unknown[] = [];
  let unread: QueueUnread | undefined;
  const run = async <T>(part: string, work: () => Promise<readonly T[]>) =>
    await work().catch((fault: unknown) => {
      faults.push(fault);
      // `passes` prints it, with the refusal's code.
      if (fault instanceof QueueUnread) unread = fault;
      else
        console.error(
          `site-runner: the ${part} failed: ${fault instanceof Error ? fault.name : 'fault'}`,
        );
      return [];
    });
  const located = await run('locate', locate);
  const claimed = claims === undefined ? [] : await run('claims', claims);
  const workFaults = faults.length;
  // A queue the corrections could not read is not asked again for the captures.
  if (captures !== undefined && unread === undefined) await run('captures', captures);
  if (unread !== undefined) throw unread;
  if (workFaults === (claims === undefined ? 1 : 2)) throw faults[0];
  if (faults.length > workFaults) throw faults[workFaults];
  return [...located, ...claimed];
}

export interface Passes {
  readonly pass: () => Promise<readonly Passed[]>;
  readonly ping: () => Promise<void>;
  /** The wait between passes, cut short when `stopping` aborts. */
  readonly sleep: (signal: AbortSignal) => Promise<void>;
  readonly stopping: AbortSignal;
}

/**
 * A pass every interval until `stopping` aborts. Each pass logs one line per
 * correction and then pings the heartbeat; a failed pass logs its fault's name,
 * or a refused queue's code, and pings nothing, so a broken runner goes quiet
 * as a stopped one does.
 */
export async function passes({ pass, ping: beat, sleep: wait, stopping }: Passes): Promise<void> {
  while (!stopping.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- one pass at a time
    const passed = await pass().catch((fault: unknown) => {
      const name = fault instanceof Error ? fault.name : 'fault';
      const line =
        fault instanceof QueueUnread && fault.code !== undefined
          ? `the queue was refused: ${fault.code}`
          : `a pass failed: ${name}`;
      console.error(`site-runner: ${line}`);
      return null;
    });
    for (const { correctionId, outcome } of passed ?? []) console.log(`${correctionId} ${outcome}`);
    // oxlint-disable-next-line no-await-in-loop
    if (passed !== null) await beat();
    // oxlint-disable-next-line no-await-in-loop
    await wait(stopping);
  }
}

/**
 * The heartbeat a pass pings, no more often than the settings file's pace: a
 * pass runs every 15 s, more than a free watcher's budget takes.
 */
export function heartbeat(
  settings: Pick<Settings, 'heartbeat' | 'heartbeatEvery'>,
  send: (address: string | undefined) => Promise<string> = ping,
  now?: () => number,
): () => Promise<void> {
  const beat = paced(settings.heartbeatEvery, send, now);
  return async () => void (await beat(settings.heartbeat));
}

async function main(): Promise<number> {
  const settings = readSettings(process.env);
  if (typeof settings === 'string') {
    console.error(`site-runner: ${settings}`);
    return 2;
  }
  const db = connect(settings.SITE_RUNNER_DATABASE_URL, { max: 2 });
  const business = settings.OPS_ASTRO_BUSINESS_ID as BusinessId;
  // A client holder is confirmed in the business by one read; the business itself needs none.
  const holder =
    settings.site.holder === business
      ? undefined
      : await db
          .withBusiness(business, async (tx) => await holderRefuses(tx, settings.site))
          .catch(() => 'SITE_RUNNER_SITE.holder could not be checked');
  if (holder !== undefined) {
    console.error(`site-runner: ${holder}`);
    await db.close();
    return 2;
  }
  // Locating only takes no claim, so it signs in nowhere.
  const agent = settings.locateOnly ? undefined : await signedIn(settings);
  if (typeof agent === 'string') {
    console.error(`site-runner: ${agent}`);
    await db.close();
    return 1;
  }
  const { pass, stop } = await hosted(settings, db, agent);
  // `launchctl bootout` sends SIGTERM: the pass in hand finishes, then everything stops.
  const stopping = new AbortController();
  process.once('SIGTERM', () => stopping.abort());
  await passes({
    pass,
    ping: heartbeat(settings),
    sleep: async (signal) =>
      void (await sleep(FOLLOW_EVERY_MS, null, { signal }).catch(() => null)),
    stopping: stopping.signal,
  });
  await stop();
  return 0;
}

if (import.meta.main) process.exitCode = await main();
