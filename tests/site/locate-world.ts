// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's locate (#1693) on the register world (`c80-register-world.ts`,
// party A's site as the providers' double names it): requests through the
// door, the source host behind a custody double that answers each catalogued
// read from the files it holds and counts every request handed to it, and
// the record reads and seeding steps the locate cases assert on. A seeding
// step that moves what the storage keeps still (a schedule backwards, a bound
// site under an open correction) steps round the triggers for its own
// statement only.

import { expect } from 'vitest';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { lease, w } from './c80-register-world.ts';
import { configuredSite } from './site-runner-world.ts';
import { locatePass } from '../../apps/site-runner/locate.ts';
import type { Passed } from '../../apps/site-runner/runner.ts';
import { custodySites, type SitePorts } from '../../apps/site-runner/sites.ts';
import type { ConfiguredSite } from '../../apps/site-runner/configured.ts';
import type { Custody, CustodyOutcome } from '../../packages/core-custody/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';

/** The default branch's head commit on the double: a 40-hex commit, as the provider names one. */
export const HEAD_COMMIT: string = `c0ffee${'1'.repeat(34)}`;
const BLOB = 'b'.repeat(40);

export interface SourceDouble {
  readonly ports: SitePorts;
  /** Every request custody was handed, as `METHOD path?query`. */
  readonly requests: string[];
  /** The files on the default branch at the head, by path. */
  readonly files: Map<string, string>;
  /** Reads that answer 500: the head (`'head'`) or a path. */
  readonly failing: Set<string>;
}

const answered = (status: number, body: unknown): CustodyOutcome =>
  status === 200
    ? {
        kind: 'answered',
        started: true,
        outbound: { ok: true, status, body: JSON.stringify(body), mediaType: 'application/json' },
        credentialKind: 'api_key',
        account: null,
      }
    : {
        kind: 'answered',
        started: true,
        outbound: { ok: false, fault: 'status', status },
        credentialKind: 'api_key',
        account: null,
      };

/** The source host behind a custody double: the head and each file it holds, every request counted. */
export function sourceDouble(files: Readonly<Record<string, string>>): SourceDouble {
  const requests: string[] = [];
  const held = new Map(Object.entries(files));
  const failing = new Set<string>();
  const custody: Pick<Custody, 'dispatch'> = {
    dispatch: (_ref, request) => {
      requests.push(`${request.method} ${request.path}`);
      const url = new URL(request.path, 'https://source.invalid');
      if (url.pathname.includes('/git/ref/heads/'))
        return Promise.resolve(
          failing.has('head')
            ? answered(500, {})
            : answered(200, { ref: 'refs/heads/main', object: { sha: HEAD_COMMIT } }),
        );
      const path = decodeURIComponent(url.pathname.split('/contents/')[1] ?? '');
      const content = held.get(path);
      if (failing.has(path) || content === undefined) return Promise.resolve(answered(500, {}));
      const encoded = Buffer.from(content, 'utf8').toString('base64');
      return Promise.resolve(
        answered(200, { sha: BLOB, content: encoded, encoding: 'base64', size: content.length }),
      );
    },
  };
  const ports: SitePorts = {
    custody,
    resolve: () => Promise.resolve(['140.82.112.6']),
    capture: {
      pool: { agencyPages: [], otherPages: [], closedPoolReviews: [] },
      resolve: () => Promise.resolve(['93.184.216.34']),
      transport: () => Promise.resolve({ kind: 'failed' }),
    },
    wait: () => Promise.resolve(),
    now: Date.now,
  };
  return { ports, requests, files: held, failing };
}

/** One locate pass of the runner configured for `site` (party A's, unless named). */
export async function locateOnce(
  double: SourceDouble,
  site: ConfiguredSite = configuredSite(),
): Promise<readonly Passed[]> {
  const ports = custodySites(double.ports, site).locate();
  const business = w.world.business as BusinessId;
  return await locatePass({ db: w.world.db.app, business, site, ports });
}

/** A correction requested through the door on `page` of the lease's task: stored `locating`. */
export async function requestOn(
  page: string,
  words?: { readonly word: string; readonly replacement: string },
  taskId: string = lease.taskId,
): Promise<string> {
  const result = await w.asRaw(w.ava, {
    command: 'live_correction.request',
    taskId,
    page,
    ...(words ?? { word: 'friendly', replacement: 'welcoming' }),
  });
  expect(codeOf(result)).toBe('not-a-refusal');
  const id = String(detailOf(result)['correctionId']);
  expect(await w.stateOf(id)).toBe('locating');
  return id;
}

export interface Row {
  readonly state: string;
  readonly locate_code: string | null;
  readonly check_failures: number;
  readonly version_id: string | null;
  readonly base_revision: string | null;
  readonly pre_image_digest: string | null;
  readonly version_digest: string | null;
  /** Seconds from now, as the database reads its clock. */
  readonly next_in: number | null;
  readonly verified_at: string | null;
}

export async function rowOf(id: string): Promise<Row> {
  const [row] = await w.world.db.admin.execute<Row>(
    `select state, locate_code, check_failures, version_id, base_revision, pre_image_digest,
            version_digest, verified_at::text as verified_at,
            extract(epoch from next_check_at - clock_timestamp())::float8 as next_in
       from public.live_corrections where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('rowOf: no such correction');
  return row;
}

/** Statements the triggers would refuse, for the seed's own statement only. */
const REPLICA = `with replica as (select set_config('session_replication_role', 'replica', true))`;

/** Due now, all at one instant (so the oldest go first): the schedule moved back, as only the seed may. */
export async function dueNow(...ids: readonly string[]): Promise<void> {
  await w.world.db.admin.execute(
    `${REPLICA} update public.live_corrections
        set next_check_at = now() - interval '1 second'
       from replica where id = any($1::uuid[])`,
    [ids],
  );
}

/** Requested `seconds` ago, as only the seed may move it. */
export async function requestedAgo(id: string, seconds: number): Promise<void> {
  await w.world.db.admin.execute(
    `${REPLICA} update public.live_corrections
        set created_at = clock_timestamp() - make_interval(secs => $2)
       from replica where id = $1`,
    [id, seconds],
  );
}

/** Party A's site bound to other providers, the triggers stepped round: a rebind forced. */
export async function forceBinding(
  fields: Partial<Record<'repository' | 'default_branch' | 'project', string>>,
): Promise<void> {
  const site = configuredSite();
  await w.world.db.admin.execute(
    `${REPLICA} update public.party_sites
        set repository = coalesce($2, repository), default_branch = coalesce($3, default_branch),
            project = coalesce($4, project)
       from replica where business_id = $5 and holder = $1`,
    [
      site.holder,
      fields.repository ?? null,
      fields.default_branch ?? null,
      fields.project ?? null,
      w.world.business,
    ],
  );
}

/** Every waiting correction of the world's business set aside, so a case starts with none due. */
export async function noneWaiting(): Promise<void> {
  await w.world.db.admin.execute(
    `update public.live_corrections set state = 'cancelled', revision = revision + 1
      where business_id = $1 and state in ('locating', 'requested')`,
    [w.world.business],
  );
}
