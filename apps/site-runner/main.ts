// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner process (`docs/local/SITE-RUNNER.md`): `node apps/site-runner/main.ts`, run
// by launchd on the M5 from a deployed main build
// (`deploy/m5/ops-astro-site-runner.plist`). It signs in as its own agent
// actor, starts custody with the two site destinations, opens its own
// database login (TLS required), and runs a pass every 15 s. After each pass
// it pings its heartbeat, so a stopped or broken runner goes quiet. SIGTERM,
// which `launchctl bootout` sends, stops custody and the database and exits.
// Its settings come from one file only its owner can read (`settings.ts`).
// Nothing printed carries a password, a key, a bearer, a token or an address.

import { setTimeout as sleep } from 'node:timers/promises';
import { createCli, httpTransport, isRefusal, unredirected } from '../cli/client.ts';
import { agentSignIn } from '../worker/sign-in.ts';
import { ping } from '../worker/heartbeat.ts';
import { pinnedTransport, systemResolver } from '../../packages/core-connectors/src/index.ts';
import { siteDestination, startCustody } from '../../packages/core-custody/src/index.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import { queueClaims, type AgentCall } from './claims.ts';
import { createSiteRunner, FOLLOW_EVERY_MS, type Claim, type Passed } from './runner.ts';
import { HOSTING_ORIGIN, readSettings, SOURCE_ORIGIN, type Settings } from './settings.ts';
import { custodySites } from './sites.ts';

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

/** A renewal's refusal, named; the runner keeps its current bearer until it lapses. */
const renewalFailed = (because: string): void => {
  console.error(`site-runner: a sign-in renewal failed: ${because}`);
};

/** Signed in as the runner's agent, with its actor id from the API's own answer; or why not. */
async function signedIn(
  settings: Settings,
): Promise<{ call: AgentCall; actorId: string } | string> {
  const login = {
    gotrueUrl: settings.OPS_ASTRO_GOTRUE_URL,
    email: settings.OPS_ASTRO_EMAIL,
    password: settings.OPS_ASTRO_PASSWORD,
    providerKey: settings.providerKey,
  };
  const bearer = await agentSignIn(login, renewalFailed, unredirected);
  if ('because' in bearer) return `sign-in refused: ${bearer.because}`;
  const call = apiCall(settings, bearer.current);
  const self = await call('session.capabilities', {});
  const actorId = 'detail' in self ? String(self.detail['agentActorId'] ?? '') : '';
  return actorId === '' ? 'the API named no agent actor for this login' : { call, actorId };
}

/** The runner on custody, the fence and its own database login, and how to stop them. */
async function hosted(settings: Settings, call: AgentCall, actorId: string) {
  const business = settings.OPS_ASTRO_BUSINESS_ID as Parameters<typeof queueClaims>[2];
  const db = connect(settings.SITE_RUNNER_DATABASE_URL, { max: 2 });
  const custody = await startCustody({
    credentialsFile: settings.SITE_RUNNER_CREDENTIALS_FILE,
    destinations: [
      siteDestination('source_control', SOURCE_ORIGIN),
      siteDestination('hosting', HOSTING_ORIGIN),
    ],
  });
  const claims = queueClaims(call, db, business);
  const sites = custodySites({
    custody,
    resolve: systemResolver,
    capture: {
      pool: { agencyPages: settings.pages, otherPages: [], closedPoolReviews: [] },
      resolve: systemResolver,
      transport: pinnedTransport(),
    },
    wait: async (ms) => await sleep(ms),
    now: Date.now,
  });
  const raiseTask = async (claim: Claim, reason: string) => {
    console.error(`site-runner: raised ${reason} on task ${claim.taskId}`);
    await claims.raise(claim, reason);
  };
  const runner = createSiteRunner({
    db,
    business,
    actorId,
    claims,
    sites,
    raiseTask,
    now: Date.now,
  });
  const stop = async () => {
    await custody.stop();
    await db.close();
  };
  return { runner, stop };
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
 * correction and then pings the heartbeat; a failed pass logs its fault's name
 * and pings nothing, so a broken runner goes quiet as a stopped one does.
 */
export async function passes({ pass, ping: beat, sleep: wait, stopping }: Passes): Promise<void> {
  while (!stopping.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- one pass at a time
    const passed = await pass().catch((fault: unknown) => {
      console.error(`site-runner: a pass failed: ${fault instanceof Error ? fault.name : 'fault'}`);
      return null;
    });
    for (const { correctionId, outcome } of passed ?? []) console.log(`${correctionId} ${outcome}`);
    // oxlint-disable-next-line no-await-in-loop
    if (passed !== null) await beat();
    // oxlint-disable-next-line no-await-in-loop
    await wait(stopping);
  }
}

async function main(): Promise<number> {
  const settings = readSettings(process.env);
  if (typeof settings === 'string') {
    console.error(`site-runner: ${settings}`);
    return 2;
  }
  const agent = await signedIn(settings);
  if (typeof agent === 'string') {
    console.error(`site-runner: ${agent}`);
    return 1;
  }
  const { runner, stop } = await hosted(settings, agent.call, agent.actorId);
  // `launchctl bootout` sends SIGTERM: the pass in hand finishes, then everything stops.
  const stopping = new AbortController();
  process.once('SIGTERM', () => stopping.abort());
  await passes({
    pass: async () => await runner.pass(),
    ping: async () => void (await ping(settings.heartbeat)),
    sleep: async (signal) =>
      void (await sleep(FOLLOW_EVERY_MS, null, { signal }).catch(() => null)),
    stopping: stopping.signal,
  });
  await stop();
  return 0;
}

if (import.meta.main) process.exitCode = await main();
