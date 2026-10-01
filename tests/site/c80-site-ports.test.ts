// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 publish binding, through the runner: an approved correction proposed by
// the composed `site.source.propose` on its own seam, then published by the
// runner on ports bound to the providers (every provider call guarded, the
// capture through the C18-1 fence) and recorded with its receipt under the
// worker lease. The providers are a double behind the transport.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ABOUT, AFTER, BEFORE, PAGE, c80World, type C80World } from './c80-world.ts';
import { MERGED, PROJECT, REPOSITORY, provider, type Provider } from './c80-site-provider.ts';
import { runLivePublish } from '../../packages/core-commands/src/index.ts';
import { siteRunnerPorts } from '../../packages/core-commands/src/commands/live-correction-ports.ts';
import {
  proposeSource,
  type CaptureOptions,
  type SiteBinding,
} from '../../packages/core-connectors/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C80 site ports: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
let lease: { leaseId: string; fence: number; taskId: string };

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80port');
  await w.setApprover(w.ben.personId);
  const picked = await w.world.pickUp(w.cal, 'publish the About correction');
  const rows = await w.world.db.admin.execute<{ readonly id: string; readonly fence: string }>(
    `select id, fence::text as fence from public.leases where task_id = $1 and state = 'live'`,
    [picked.taskId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no live lease after pickup');
  lease = { leaseId: row.id, fence: Number(row.fence), taskId: picked.taskId };
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** An approved correction and its seam, as the request stored them. */
async function approved(): Promise<{ id: string; seam: string }> {
  const detail = detailOf(await w.request(w.ava, { taskId: lease.taskId }));
  const id = String(detail['correctionId']);
  expect(codeOf(await w.approve(w.ben, id, String(detail['versionId'])))).toBe('not-a-refusal');
  const rows = await w.world.db.admin.execute<{ readonly seam: string }>(
    `select seam from public.live_corrections where id = $1`,
    [id],
  );
  return { id, seam: rows[0]?.seam ?? '' };
}

/** The fence's inputs over the agency's page, served showing the corrected word. */
const fence = (captured: string[]): CaptureOptions => ({
  pool: { agencyPages: [PAGE], otherPages: [], closedPoolReviews: [] },
  resolve: () => Promise.resolve(['93.184.215.14']),
  transport: (request) => {
    captured.push(request.url.href);
    return Promise.resolve({
      kind: 'answer',
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: new TextEncoder().encode(`<!doctype html><main>${AFTER}</main>`),
    });
  },
});

/** Proposed on the correction's seam through the composition, then bound. */
async function proposedAndBound(
  seam: string,
  site: Provider,
  raised: string[],
  captured: string[],
) {
  const proposal = await proposeSource(
    {
      repository: REPOSITORY,
      path: ABOUT,
      defaultBranch: 'main',
      branch: seam,
      baseRevision: 'rev-1',
      blob: 'blob-base',
      after: AFTER,
    },
    site.deps,
  );
  if (proposal.kind !== 'ok') throw new Error(`proposal not opened: ${proposal.code}`);
  const binding: SiteBinding = {
    repository: REPOSITORY,
    path: ABOUT,
    defaultBranch: 'main',
    project: PROJECT,
    pageUrl: PAGE,
    proposal: { branch: seam, ...proposal.value },
    change: { before: BEFORE, after: AFTER },
  };
  return siteRunnerPorts(binding, {
    ...site.deps,
    capture: fence(captured),
    raiseTask: (reason) => {
      raised.push(reason);
      return Promise.resolve();
    },
    now: () => Date.now(),
  });
}

const at = (correctionId: string) => ({
  business: w.world.business,
  correctionId,
  leaseId: lease.leaseId,
  fence: lease.fence,
});

async function observed(id: string): Promise<Record<string, { observed: string }>> {
  const rows = await w.world.db.admin.execute<{ readonly o: Record<string, { observed: string }> }>(
    `select observations as o from public.live_correction_receipts
      where correction_id = $1 order by created_at desc limit 1`,
    [id],
  );
  return rows[0]?.o ?? {};
}

describe.skipIf(serverUrl === undefined)('C80 publish binding', () => {
  it('publishes a proposed, approved correction on the bound ports and records it live', async () => {
    const { id, seam } = await approved();
    const site = provider({ content: BEFORE });
    const raised: string[] = [];
    const captured: string[] = [];
    const ports = await proposedAndBound(seam, site, raised, captured);
    expect(await runLivePublish(w.world.db.app, at(id), ports)).toMatchObject({
      kind: 'recorded',
      state: 'live',
    });
    const receipt = await observed(id);
    expect(receipt['published_revision']).toEqual({ observed: MERGED });
    expect(receipt['deployment_id']).toEqual({ observed: 'dpl_merged' });
    expect(site.sent.filter((sent) => sent.target.endsWith('/merge'))).toHaveLength(1);
    expect([captured, raised, site.state.content]).toEqual([[PAGE], [], AFTER]);
  });

  it('a merge another worker already made is recorded unknown with a task, never failed', async () => {
    const { id, seam } = await approved();
    const site = provider({ content: BEFORE });
    const raised: string[] = [];
    const ports = await proposedAndBound(seam, site, raised, []);
    if (site.state.request) site.state.request.merged = true;
    expect(await runLivePublish(w.world.db.app, at(id), ports)).toMatchObject({
      kind: 'recorded',
      state: 'unknown',
    });
    expect([await w.stateOf(id), raised]).toEqual(['unknown', ['REQUEST_ALREADY_MERGED']]);
    expect((await observed(id))['unknown_outcome_reconciliation']).toEqual({
      observed: `REQUEST_ALREADY_MERGED, read back by ${seam}`,
    });
  });
});
