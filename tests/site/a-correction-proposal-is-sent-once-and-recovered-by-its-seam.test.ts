// SPDX-License-Identifier: AGPL-3.0-only
//
// An approved correction's proposal (branch, commit, request) is claimed under
// the worker's live lease before its first send, sent by one run only, and
// recovered by its seam after a lost answer or a lost worker: the seam's state
// is recorded proposed only when it is exactly the claim and the approved
// after-image, and anything else waits on one person task. Only a proposed row
// feeds the publish's binding. Every provider here is a stand-in.

import { describe, expect, it } from 'vitest';
import { proposalForBinding, proposeCorrection } from '../../packages/core-commands/src/index.ts';
import {
  claimProposal,
  readPartySite,
  settleProposal,
} from '../../packages/core-records/src/index.ts';
import { siteBindingFor } from '../../packages/core-connectors/src/index.ts';
import { AFTER, BEFORE } from './c80-world.ts';
import { approved, at, lease, serverUrl, useRegisterWorld, w } from './c80-register-world.ts';
import { standIn, type Knobs, type StandIn, type Step } from './proposal-stand-in.ts';

useRegisterWorld();

const BASE = { revision: 'rev-1', blob: 'blob-base', content: BEFORE };
const PROPOSED = { kind: 'proposed', head: 'commit-1', request: '17' };
const WAITS = { kind: 'refused', code: 'OUTCOME_UNKNOWN', waitsOn: 'person' };

interface Row {
  readonly state: string;
  readonly head_commit: string | null;
  readonly request_number: string | null;
  readonly seam_branch: string;
  readonly base_revision: string;
  readonly pre_image_blob: string;
}

async function rowOf(id: string): Promise<Row | undefined> {
  const rows = await w.world.db.admin.execute<Row>(
    `select state, head_commit, request_number, seam_branch, base_revision, pre_image_blob
       from public.live_correction_proposals where correction_id = $1`,
    [id],
  );
  return rows[0];
}

const seamOf = async (id: string): Promise<string> =>
  (
    await w.world.db.admin.execute<{ seam: string }>(
      'select seam from public.live_corrections where id = $1',
      [id],
    )
  )[0]?.seam ?? '';

const propose = async (id: string, site: StandIn) =>
  await proposeCorrection(w.world.db.app, at(id), site.ports);

/** A correction approved, and a run of its proposal lost to `knobs`, leaving its row claimed. */
async function lostAt(knobs: Knobs): Promise<{ id: string; site: StandIn }> {
  const id = await approved();
  const site = standIn(BASE, knobs);
  await expect(propose(id, site)).rejects.toThrow('worker lost mid-proposal');
  expect((await rowOf(id))?.state).toBe('claimed');
  knobs.crash = undefined;
  return { id, site };
}

describe.skipIf(serverUrl === undefined)('a correction proposal, sent once', () => {
  it('claims the row before the first send, then records it proposed', async () => {
    const id = await approved();
    const atSend: string[] = [];
    const site = standIn(BASE, {
      onSend: async (step: Step) => {
        atSend.push(`${step} ${(await rowOf(id))?.state ?? 'no row'}`);
      },
    });
    expect(await propose(id, site)).toEqual(PROPOSED);
    expect(atSend).toEqual(['branch claimed', 'commit claimed', 'request claimed']);
    expect(await rowOf(id)).toEqual({
      state: 'proposed',
      head_commit: 'commit-1',
      request_number: '17',
      seam_branch: await seamOf(id),
      base_revision: 'rev-1',
      pre_image_blob: 'blob-base',
    });
  });

  it('a second run of the same correction sends nothing and answers the same proposal', async () => {
    const id = await approved();
    const site = standIn(BASE);
    expect(await propose(id, site)).toEqual(PROPOSED);
    expect(await propose(id, site)).toEqual(PROPOSED);
    expect(site.sent).toEqual(['branch', 'commit', 'request']);
    expect(site.requests).toHaveLength(1);
  });

  it('a run without the live lease claims nothing and sends nothing', async () => {
    const id = await approved();
    const site = standIn(BASE);
    const stale = { ...at(id), fence: lease.fence + 99 };
    expect(await proposeCorrection(w.world.db.app, stale, site.ports)).toEqual({
      kind: 'refused',
      code: 'LEASE_NOT_OWNED',
    });
    expect(site.sent).toEqual([]);
    expect(await rowOf(id)).toBeUndefined();
  });
});

const tampers: readonly (readonly [string, (site: StandIn, seam: string) => void])[] = [
  [
    'the branch head holds other bytes than the after-image',
    (site, seam) => {
      const head = site.branches.get(seam) ?? '';
      const commit = site.commits.get(head);
      if (commit !== undefined) site.commits.set(head, { ...commit, content: BEFORE });
    },
  ],
  [
    'the branch starts at another commit than the claimed base',
    (site, seam) => {
      const head = site.branches.get(seam) ?? '';
      const commit = site.commits.get(head);
      if (commit !== undefined) site.commits.set(head, { ...commit, parent: 'rev-0' });
    },
  ],
  [
    'the file at the base is another blob than the claimed pre-image',
    (site) => {
      site.commits.set('rev-1', { parent: 'root', blob: 'blob-other', content: BEFORE });
    },
  ],
];

describe.skipIf(serverUrl === undefined)('a correction proposal, recovered by its seam', () => {
  it('a restart after the worker was lost once the request opened records it proposed, sending nothing', async () => {
    const { id, site } = await lostAt({ crash: 'request' });
    expect(await propose(id, site)).toEqual(PROPOSED);
    expect(site.sent).toEqual(['branch', 'commit', 'request']);
    expect(site.raised).toEqual([]);
    expect((await rowOf(id))?.state).toBe('proposed');
  });

  it('a restart after the worker was lost before the request opened waits on one person task', async () => {
    const { id, site } = await lostAt({ crash: 'commit' });
    expect(await propose(id, site)).toEqual(WAITS);
    expect(await propose(id, site)).toEqual(WAITS);
    expect(site.sent).toEqual(['branch', 'commit']);
    expect(site.raised).toEqual(['OUTCOME_UNKNOWN']);
    expect(await rowOf(id)).toMatchObject({ state: 'unknown', head_commit: null });
    expect(await w.stateOf(id)).toBe('unknown');
  });

  it('a request whose answer was lost after it opened is recorded proposed', async () => {
    const id = await approved();
    const site = standIn(BASE, { cut: { step: 'request', landed: true } });
    expect(await propose(id, site)).toEqual(PROPOSED);
    expect(site.raised).toEqual([]);
  });

  it('a request whose answer was lost before it opened waits on one person task', async () => {
    const id = await approved();
    const site = standIn(BASE, { cut: { step: 'request', landed: false } });
    expect(await propose(id, site)).toEqual(WAITS);
    expect(site.raised).toEqual(['OUTCOME_UNKNOWN']);
    expect((await rowOf(id))?.state).toBe('unknown');
  });
});

describe.skipIf(serverUrl === undefined)(
  'a correction proposal, when the seam is not the claim',
  () => {
    it.each(tampers)('a restart where %s waits on a person', async (_, tamper) => {
      const { id, site } = await lostAt({ crash: 'request' });
      tamper(site, await seamOf(id));
      expect(await propose(id, site)).toEqual(WAITS);
      expect(site.raised).toEqual(['OUTCOME_UNKNOWN']);
      expect(await rowOf(id)).toMatchObject({ state: 'unknown', request_number: null });
    });

    it('a settled proposal keeps its answer', async () => {
      const { id, site } = await lostAt({ crash: 'commit' });
      expect(await propose(id, site)).toEqual(WAITS);
      const moved = w.world.db.admin.execute(
        `update public.live_correction_proposals
          set state = 'proposed', head_commit = 'commit-1', request_number = '17'
        where correction_id = $1`,
        [id],
      );
      await expect(moved).rejects.toThrow('a settled proposal does not move');
    });
  },
);

const inAlpha = <T>(work: Parameters<typeof w.world.db.app.withBusiness<T>>[1]) =>
  w.world.db.app.withBusiness(w.world.business, work);

type Proposal = Parameters<typeof siteBindingFor>[2]['proposal'];

/** The correction's binding on its client's site as stored, from the proposal given. */
async function bindingFrom(id: string, proposal: Proposal) {
  const [pin] = await w.world.db.admin.execute<{
    partyId: string;
    pageUrl: string;
    targetPath: string;
    seam: string;
    word: string;
    replacement: string;
    preImageDigest: string;
  }>(
    `select party_id as "partyId", page_url as "pageUrl", target_path as "targetPath", seam,
            word, replacement, pre_image_digest as "preImageDigest"
       from public.live_corrections where id = $1`,
    [id],
  );
  if (pin === undefined) throw new Error('no correction');
  const site = await inAlpha(async (tx) => await readPartySite(tx, pin.partyId));
  if (site === undefined) throw new Error('no site');
  const { targetPath: path, word, replacement, preImageDigest, pageUrl, seam } = pin;
  return siteBindingFor(site, pin, {
    proposal,
    change: { before: BEFORE, after: AFTER },
    version: {
      target: { path, word, replacement },
      preImageDigest,
      baseRevision: 'rev-1',
      pageUrl,
      seam,
    },
  });
}

describe.skipIf(serverUrl === undefined)("the publish's binding, from the proposal", () => {
  it('binds nothing from a correction with no proposal, a claimed one or an unknown one', async () => {
    const none = await approved();
    const claimed = await approved();
    const unknown = await approved();
    await inAlpha(async (tx) => {
      await claimProposal(tx, at(claimed), 'blob-base');
      await claimProposal(tx, at(unknown), 'blob-base');
      await settleProposal(tx, at(unknown), { state: 'unknown' });
    });
    for (const id of [none, claimed, unknown]) {
      // oxlint-disable-next-line no-await-in-loop -- one correction at a time
      expect(await proposalForBinding(w.world.db.app, at(id))).toEqual({
        ok: false,
        code: 'PROPOSAL_NOT_MADE',
      });
    }
  });

  it('binds a proposed correction on its seam, head and request', async () => {
    const id = await approved();
    expect(await propose(id, standIn(BASE))).toEqual(PROPOSED);
    const read = await proposalForBinding(w.world.db.app, at(id));
    if (!read.ok) throw new Error(`no proposal: ${read.code}`);
    const made = await bindingFrom(id, read.proposal);
    expect(made.ok && made.binding.proposal).toEqual({
      branch: await seamOf(id),
      request: '17',
      head: 'commit-1',
      versionDigest: read.proposal.versionDigest,
    });
  });
});
