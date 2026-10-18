// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the site runner's cases (#1692) run in: C80's register world, its
// party A site named as the providers' double names it, the doubles behind the
// runner's ports, and claims holding the world's lease on one correction.
// `clock` is the runner's and the ports' time, moved by the cases.

import { beforeAll } from 'vitest';
import {
  createSiteRunner,
  type Claim,
  type Claims,
  type Sites,
} from '../../apps/site-runner/runner.ts';
import { siteRunnerPorts, type RunnerPorts } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { doubles } from './c80-runner-doubles.ts';
import { BEFORE } from './c80-world.ts';
import {
  MERGED,
  PROJECT,
  REPOSITORY,
  json,
  provider,
  type Provider,
  type SentRequest,
} from './c80-site-provider.ts';
import { lease, serverUrl, useRegisterWorld, w } from './c80-register-world.ts';

/** C80's register world, party A's site named as the providers' double names it. */
export function useRunnerWorld(): void {
  useRegisterWorld();
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    await w.world.db.admin.execute(
      `update public.party_sites set repository = $2, project = $3 where party_id = $1`,
      [w.partyA, REPOSITORY, PROJECT],
    );
  });
}

const html = (text: string): Uint8Array =>
  new TextEncoder().encode(`<!doctype html><html><body><main>${text}</main></body></html>`);

export interface World {
  readonly site: Provider;
  readonly sites: Sites;
  readonly raised: string[];
  /** Every page address the fence's transport was asked for. */
  readonly captured: string[];
}

export interface RunnerOn {
  readonly runner: ReturnType<typeof createSiteRunner>;
  /** The corrections whose claims were handed back, in order. */
  readonly released: string[];
  /** The lease's next renewal answers lost. */
  readonly lose: () => void;
  readonly claims: Claims;
}

/** The providers, with the base revision's file kept as it was, and every raised task. */
export function world(): World {
  const site: Provider = provider({ content: BEFORE });
  const base = { blob: site.state.blob, content: BEFORE };
  const raised: string[] = [];
  const captured: string[] = [];
  const refused = { kind: 'refused', code: 'SEAM_READ_NOT_CATALOGUED' } as const;
  const sites: Sites = {
    propose: (_site, _path, raiseTask) => ({
      connector: site.deps,
      // The file at a commit; only the base revision is ever asked for here.
      file: (at) =>
        Promise.resolve(at === 'rev-1' ? ({ kind: 'ok', value: base } as const) : refused),
      branch: () => Promise.resolve(refused),
      request: () => Promise.resolve(refused),
      raiseTask,
    }),
    publish: (binding, raiseTask) => doublePorts(site, captured, binding, raiseTask),
  };
  return { site, sites, raised, captured };
}

export const time = { clock: 10_000 };

function doublePorts(
  site: Provider,
  captured: string[],
  binding: Parameters<Sites['publish']>[0],
  raiseTask: (reason: string) => Promise<void>,
): RunnerPorts {
  const transport = (request: { url: URL }) => {
    captured.push(request.url.href);
    return Promise.resolve({
      kind: 'answer' as const,
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: html(site.state.content),
    });
  };
  return siteRunnerPorts(binding, {
    ...site.deps,
    capture: { ...doubles().capture, transport },
    raiseTask,
    now: () => time.clock,
  });
}

/** Claims holding the world's lease on one correction until it is released. */
function claimsOn(
  correctionId: string,
  held?: { leaseId: string; fence: number },
): Omit<RunnerOn, 'runner'> {
  const claim: Claim = {
    correctionId,
    taskId: lease.taskId,
    ...(held ?? { leaseId: lease.leaseId, fence: lease.fence }),
  };
  const released: string[] = [];
  let taken = false;
  let live = true;
  return {
    released,
    lose: () => {
      live = false;
    },
    claims: {
      take: (): Promise<readonly Claim[]> => {
        if (taken) return Promise.resolve([]);
        taken = true;
        return Promise.resolve([claim]);
      },
      beat: () => Promise.resolve(live),
      release: (done: Claim) => {
        released.push(done.correctionId);
        return Promise.resolve();
      },
    },
  };
}

export function runnerOn(
  correctionId: string,
  given: World,
  db: Database = w.world.db.app,
  held?: { leaseId: string; fence: number },
): RunnerOn {
  const claims = claimsOn(correctionId, held);
  const runner = createSiteRunner({
    db,
    business: w.world.business,
    actorId: lease.holder,
    claims: claims.claims,
    sites: given.sites,
    raiseTask: (_claim, reason) => {
      given.raised.push(reason);
      return Promise.resolve();
    },
    now: () => time.clock,
  });
  return { runner, ...claims };
}

/** The merged deployment still building: read as not served yet, so a run leaves it accepted. */
const BUILDING = 'GET api.vercel.com /v13/deployments/';
export const building = (site: Provider): void => {
  site.state.answers[BUILDING] = json({
    id: 'dpl_merged',
    readyState: 'BUILDING',
    target: 'production',
    meta: { githubCommitSha: MERGED },
  });
};
export const built = (site: Provider): void => {
  delete site.state.answers[BUILDING];
};

export const writes = (site: Provider): SentRequest[] =>
  site.sent.filter((sent) => sent.method !== 'GET');
/** The publish: the one contents write on the default branch. */
export const merges = (site: Provider): SentRequest[] =>
  site.sent.filter((sent) => sent.method === 'PUT' && sent.body['branch'] === 'main');
