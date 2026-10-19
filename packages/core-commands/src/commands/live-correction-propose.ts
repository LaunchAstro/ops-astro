// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's proposal step: the approved correction's branch, commit and request
// (`proposeSource`), sent by one run and recovered by its seam. The row is
// claimed under the run's lease before the first send; a second job, or this
// one restarted, finds it and sends nothing. An answered proposal is recorded
// `proposed`; anything else is reconciled by the seam (the branch's head and
// parent, the file's blob at the base and text at the head, the open request by
// head branch) and recorded `proposed` only on an exact match with the claim and
// the after-image, else `unknown` with one person task (`askOnce`). Only a
// `proposed` row feeds the binding. No transaction spans a provider call, and
// nothing here holds a credential: the connector borrows one per call. Before
// the first write the default branch's head is read afresh and its file must
// still hold the pinned pre-image, or nothing is sent (`CONTENT_DRIFTED`, one
// person task); the publish's blob precondition stays the final check.

import {
  claimProposal,
  readCorrectionForRun,
  readPartySite,
  readProposal,
  settleProposal,
  type CorrectionProposal,
  type Database,
  type LiveCorrection,
  type Settlement,
} from '../../../core-records/src/index.ts';
import {
  approvedChange,
  contentDigest,
  proposeSource,
  type CallDependencies,
  type ProviderResult,
  type SiteBinding,
} from '../../../core-connectors/src/index.ts';
import { targetOf } from './live-correction-observations.ts';
import { askOnce, settleAsk } from './live-correction-effect.ts';
import type { CorrectionRun } from './live-correction-run.ts';

type Read<T> = (at: string) => Promise<ProviderResult<T>>;

/** What the seam holds, each a read of the correction's repository and file. */
export interface SeamReads {
  /** The seam branch's head commit and that commit's parent, or null where there is no branch. */
  readonly branch: Read<{ readonly head: string; readonly parent: string } | null>;
  /** The correction's site file at a commit: its blob and its text. */
  readonly file: Read<{ readonly blob: string; readonly content: string }>;
  /** The open request whose head is the seam branch: its number and head commit, or null. */
  readonly request: Read<{ readonly number: string; readonly head: string } | null>;
}

export interface ProposePorts extends SeamReads {
  /** The default branch's head commit now (`site.source.head`), read before the first write. */
  readonly head: () => Promise<ProviderResult<string>>;
  /** `proposeSource`'s guarded calls: the credential is borrowed per call, never held here. */
  readonly connector: CallDependencies;
  readonly raiseTask: (reason: string) => Promise<void>;
}

export type ProposeResult =
  | { readonly kind: 'proposed'; readonly head: string; readonly request: string }
  | { readonly kind: 'refused'; readonly code: string; readonly waitsOn?: 'person' };

type Image = { readonly blob: string; readonly after: string };

const refused = (code: string): ProposeResult => ({ kind: 'refused', code });

async function waiting(code: string, ports: ProposePorts): Promise<ProposeResult> {
  await ports.raiseTask(code);
  return { kind: 'refused', code, waitsOn: 'person' };
}

/** A lease refusal; a narrowed delegation waits on its person, as the runner's does. */
const leaseRefused = async (code: string, ports: ProposePorts): Promise<ProposeResult> =>
  code === 'DELEGATION_NARROWED' ? await waiting(code, ports) : refused(code);

/** The pre-image at the base revision, checked against its digest, and the version's after-image. */
async function imageOf(correction: LiveCorrection, ports: ProposePorts): Promise<Image | string> {
  const base = await ports.file(correction.baseRevision);
  if (base.kind !== 'ok') return 'CONTENT_DRIFT_UNCHECKED';
  if (contentDigest(base.value.content) !== correction.preImageDigest) return 'CONTENT_DRIFTED';
  const { preImageDigest, baseRevision, pageUrl, seam } = correction;
  const pin = { target: targetOf(correction), preImageDigest, baseRevision, pageUrl, seam };
  const after = approvedChange(pin, base.value.content, correction.versionDigest)?.files[0]?.after;
  return typeof after === 'string' ? { blob: base.value.blob, after } : 'PROPOSAL_SUPERSEDED';
}

/**
 * The file on the default branch now still holds the pinned pre-image: the head read afresh and
 * the file at it (#1693). A page edited since the pin is `CONTENT_DRIFTED`; a read that does not
 * answer leaves it unchecked.
 */
async function stillPinned(
  correction: LiveCorrection,
  ports: ProposePorts,
): Promise<string | undefined> {
  const head = await ports.head();
  if (head.kind !== 'ok') return 'CONTENT_DRIFT_UNCHECKED';
  const now = await ports.file(head.value);
  if (now.kind !== 'ok') return 'CONTENT_DRIFT_UNCHECKED';
  return contentDigest(now.value.content) === correction.preImageDigest
    ? undefined
    : 'CONTENT_DRIFTED';
}

const AT = { step: 'publish', outcome: 'unknown' } as const;

/** An unknown proposal: one person task, asked once across runs (`askOnce`). */
async function waitsOnPerson(
  db: Database,
  run: CorrectionRun,
  ports: ProposePorts,
): Promise<ProposeResult> {
  const asked = await askOnce(db, run, AT);
  if (typeof asked === 'string') return await leaseRefused(asked, ports);
  if (asked) {
    await ports.raiseTask('OUTCOME_UNKNOWN').catch(async (error: unknown) => {
      await settleAsk(db, run, AT, 'none').catch(() => null);
      throw error;
    });
    await settleAsk(db, run, AT, 'person');
  }
  return { kind: 'refused', code: 'OUTCOME_UNKNOWN', waitsOn: 'person' };
}

/** A settled row's answer: its proposal, or the one person task an unknown waits on. */
async function answered(
  db: Database,
  run: CorrectionRun,
  row: CorrectionProposal,
  ports: ProposePorts,
): Promise<ProposeResult> {
  const { state, head, request } = row;
  if (state === 'proposed' && head !== null && request !== null)
    return { kind: 'proposed', head, request };
  return await waitsOnPerson(db, run, ports);
}

/** The row settled once under the lease, then answered as it stands. */
async function settle(
  db: Database,
  run: CorrectionRun,
  settlement: Settlement,
  ports: ProposePorts,
): Promise<ProposeResult> {
  const settled = await db.withBusiness(
    run.business,
    async (tx) => await settleProposal(tx, run, settlement),
  );
  if (!settled.ok) return await leaseRefused(settled.code, ports);
  return await answered(db, run, settled.proposal, ports);
}

/** The proposal the seam holds, when it is exactly the claim's and the after-image's. */
async function seamHolds(
  claim: CorrectionProposal,
  image: Image,
  ports: ProposePorts,
): Promise<Settlement | undefined> {
  if (image.blob !== claim.preImageBlob) return undefined;
  const branch = await ports.branch(claim.seam);
  if (branch.kind !== 'ok' || branch.value?.parent !== claim.baseRevision) return undefined;
  const { head } = branch.value;
  const file = await ports.file(head);
  if (file.kind !== 'ok' || file.value.content !== image.after) return undefined;
  const request = await ports.request(claim.seam);
  if (request.kind !== 'ok' || request.value?.head !== head) return undefined;
  return { state: 'proposed', head, request: request.value.number };
}

/** A claimed row reconciled by its seam: `proposed` on an exact match, else `unknown`. */
async function reconcile(
  db: Database,
  run: CorrectionRun,
  claim: CorrectionProposal,
  image: Image | string,
  ports: ProposePorts,
): Promise<ProposeResult> {
  const held = typeof image === 'string' ? undefined : await seamHolds(claim, image, ports);
  return await settle(db, run, held ?? { state: 'unknown' }, ports);
}

/** A row another claim wrote: its answer, a claim still in flight left alone, or a lost one reconciled; never a send. */
async function follow(
  db: Database,
  run: CorrectionRun,
  row: CorrectionProposal,
  correction: LiveCorrection,
  ports: ProposePorts,
): Promise<ProposeResult> {
  if (row.state !== 'claimed') return await answered(db, run, row, ports);
  // Inside its send window the claim's sender may still be at work: nothing is
  // read from the seam or settled, so its proposal is not made unknown mid-send.
  if (row.inFlight) return refused('PROPOSAL_IN_FLIGHT');
  return await reconcile(db, run, row, await imageOf(correction, ports), ports);
}

/** Propose an approved correction once, or recover the proposal a claim already made. */
export async function proposeCorrection(
  db: Database,
  run: CorrectionRun,
  ports: ProposePorts,
): Promise<ProposeResult> {
  const read = await db.withBusiness(run.business, async (tx) => {
    const held = await readCorrectionForRun(tx, run);
    if (!held.ok) return held;
    const { correction } = held;
    const site = await readPartySite(tx, correction.partyId);
    return { ok: true, correction, site, row: await readProposal(tx, run.correctionId) } as const;
  });
  if (!read.ok) return await leaseRefused(read.code, ports);
  const { correction, site, row } = read;
  if (row !== undefined) return await follow(db, run, row, correction, ports);
  if (correction.state !== 'approved') return refused('APPROVAL_MISSING');
  if (site === undefined) return refused('PAGE_OUTSIDE_PARTY_SITE');
  const image = await imageOf(correction, ports);
  // Before the first write: the file at the base revision, then the default branch's file now.
  const drift = typeof image === 'string' ? image : await stillPinned(correction, ports);
  if (drift === 'CONTENT_DRIFTED') return await waiting(drift, ports);
  if (drift !== undefined) return refused(drift);
  if (typeof image === 'string') return refused(image);
  const claim = await db.withBusiness(
    run.business,
    async (tx) => await claimProposal(tx, run, image.blob),
  );
  if (!claim.ok) return await leaseRefused(claim.code, ports);
  if (!claim.fresh) return await follow(db, run, claim.proposal, correction, ports);
  const { baseRevision, versionDigest } = correction;
  const input = { site, correction, baseRevision, versionDigest, ...image };
  const sent = await proposeSource(input, ports.connector);
  if (sent.kind !== 'ok') return await reconcile(db, run, claim.proposal, image, ports);
  const { head, request } = sent.value;
  return await settle(db, run, { state: 'proposed', head, request }, ports);
}

/**
 * The proposal a publish's binding is made from (`siteBindingFor`): only a
 * `proposed` row, read under the lease; any other state, or none, binds nothing.
 */
export async function proposalForBinding(
  db: Database,
  run: CorrectionRun,
): Promise<
  | { readonly ok: true; readonly proposal: Omit<SiteBinding['proposal'], 'branch'> }
  | { readonly ok: false; readonly code: string }
> {
  return await db.withBusiness(run.business, async (tx) => {
    const held = await readCorrectionForRun(tx, run);
    if (!held.ok) return held;
    const row = await readProposal(tx, run.correctionId);
    if (row?.state !== 'proposed' || row.head === null || row.request === null)
      return { ok: false, code: 'PROPOSAL_NOT_MADE' } as const;
    const { versionDigest } = held.correction;
    return { ok: true, proposal: { request: row.request, head: row.head, versionDigest } } as const;
  });
}
