// SPDX-License-Identifier: AGPL-3.0-only
//
// The decisions a read returns, verified against the bytes the database holds.
//
// A decision is the one record this slice treats as append-only and signed
// (G02), and the transaction contract's reads verify "signature and chain
// against persisted exact bytes" (T2). A read that handed the stored signing
// fields to a page unchecked would make the chain decoration: a row altered by
// anyone with owner access, a restore or an import would read exactly like one
// that was decided. So every decision a proposal read returns has been through
// `verifyChain` first, and a decision that fails is not returned at all.
//
// Three choices are load-bearing.
//
// **The chain is the business's, walked from genesis.** `decide` links each
// decision to the previous one *in the business*, whatever task it was on, so
// a walk over one lineage's rows would start mid-chain and have nothing to
// compare its first `prev_hash` against. This walks every decision in the
// business up to the newest one the read returns. A decision on another task
// that was removed or rewritten breaks the reads after it, which is what a
// chain is for. Later decisions are not read: they cannot change whether the
// returned ones hold.
//
// **The payload is the stored JSON, not the digest.** `verifyChain` recomputes
// the digest from the payload before it checks the signature (R9), so a
// payload altered under its old digest, signature and hash is caught.
//
// **A failure is a fault, never a partial answer.** `DecisionIntegrityError`
// names where the chain first breaks. The caller's transaction ends with it,
// and nothing is written or repaired: the stored evidence is left exactly as
// it was found, because the tampered row is the evidence. A missing signing
// key is the same failure, since "could not verify" returned as if it were
// "verified" is the defect this file exists to remove.
//
// **Each row is checked under its own link version and its own key.** A v2
// or v3 link (`signing.ts`, `LinkVersion`) covers the round, the time, the
// lineage, the acting actor, the evidence digest and the key id as well; a v1
// row is verified as v1, never rewritten, and the read reports `linkVersion: 1`
// so nobody takes it for more than it covers. Keys come from a resolver, so a row
// signed under a retained older key id verifies with that key, and an id the
// resolver does not know fails.
//
// **A column shown is a column signed, or the read says it is not.** The
// chain proves the payload was signed and the link covers the columns, but
// the link hash is unkeyed: a writer who changes a column and recomputes every
// later link leaves a chain that holds. So after `verifyChain` each row's
// columns are compared with its own signed payload (`boundColumns`), and any
// difference is the same named failure. Every format signed the gate, version,
// decision, person and evidence digest, so those are bound on every row: a
// fabricated signer, a flipped decision or an approval copied onto another
// gate fails on v1 and v2 as well. v3 also signed the round, time, lineage,
// acting actor, id, sequence, previous link and key id, so on v3 those are
// bound too; on v1 and v2 they are covered by the unkeyed link alone, and the
// proposal read lists what each row's signature covers (`signedFields`).
//
// One check sits beside `verifyChain` for every row: its `lineage_id` must be
// the lineage its gate's version belongs to. The gate and version are covered
// by every link version; the lineage column, which is what this read filters
// on, is covered only by v2.
//
// **A chain cannot see what was never in it.** Removing the newest decisions
// in a business leaves a shorter chain that verifies from genesis to its new
// head. So the read also checks the decisions against what the gates and
// lineages say happened (U1): a gate stored `approved`, `rejected` or
// `changes_requested` has exactly the one decision that moved it; a decision
// has the gate state it produced; a rejected lineage has its rejection; and a
// lineage's gates never reach a round its requested changes do not account
// for. Any of these missing is the same named failure as a broken link.

import type { TenantQuery } from '../tenancy/database.ts';
import {
  type KeyResolver,
  type LinkVersion,
  type SigningKey,
  decidedAtText,
  decisionLink,
  keyResolver,
  linkVersionOf,
  verifyChain,
} from '../../../core-runtime/src/signing.ts';

/** The one failure a verified read has. `message` names where the chain breaks. */
export class DecisionIntegrityError extends Error {
  readonly code = 'DECISION_INTEGRITY';

  constructor(where: string) {
    super(`decision chain does not verify: ${where}`);
    this.name = 'DecisionIntegrityError';
  }
}

export interface VerifiedDecisionRow {
  readonly lineage_id: string;
  readonly gate_lineage_id: string | null;
  readonly id: string;
  readonly seq: string;
  readonly gate_id: string;
  readonly version_id: string;
  readonly decision: string;
  readonly round: number;
  readonly decided_by_person_id: string;
  readonly decided_by_actor_id: string;
  readonly decided_at: Date;
  /** `decided_at` in the spelling the v2 link covers. */
  readonly decided_at_text: string;
  readonly evidence_digest: string;
  readonly payload: Record<string, unknown>;
  readonly payload_digest: string;
  readonly signing_key_id: string;
  readonly signature: string;
  readonly prev_hash: string;
  readonly hash: string;
}

/** A verified row and the link version it verified under. */
export interface VerifiedDecision extends VerifiedDecisionRow {
  readonly link_version: LinkVersion;
}

/**
 * The decisions on these lineages, oldest first, each verified along the
 * business chain. Throws `DecisionIntegrityError` rather than return one that
 * does not hold.
 *
 * `keys` resolves a key id to its key. A single key is a resolver with one
 * entry; `null` means none is configured.
 */
export async function readVerifiedDecisions(
  tx: TenantQuery,
  lineageIds: readonly string[],
  keys: KeyResolver | SigningKey | null,
): Promise<readonly VerifiedDecision[]> {
  if (lineageIds.length === 0) return [];

  const chain = await readChainPrefix(tx, lineageIds);
  const returned = chain.length === 0 ? [] : verified(chain, lineageIds, keys);
  const missing = await missingDecisions(tx, lineageIds, returned);
  if (missing !== null) throw new DecisionIntegrityError(missing);
  return returned;
}

/** The chain walked under each row's own link version and key, then filtered to the lineages. */
function verified(
  chain: readonly VerifiedDecisionRow[],
  lineageIds: readonly string[],
  keys: KeyResolver | SigningKey | null,
): readonly VerifiedDecision[] {
  if (keys === null) {
    throw new DecisionIntegrityError(
      'no signing key is configured, so the stored decisions cannot be verified',
    );
  }
  const versioned: VerifiedDecision[] = [];
  for (const row of chain) {
    const version = linkVersionOf(row.payload);
    if (version === undefined) {
      throw new DecisionIntegrityError(`seq ${row.seq}: the payload names an unknown link version`);
    }
    versioned.push(Object.assign({}, row, { link_version: version }));
  }
  const resolve = typeof keys === 'function' ? keys : keyResolver([keys]);
  const broken = verifyChain(
    resolve,
    versioned.map((row) => Object.assign({}, row, { seq: Number(row.seq) })),
    linkFields,
  );
  if (broken !== null) throw new DecisionIntegrityError(broken);
  for (const row of versioned) {
    const unsigned = boundColumns(row).find(([, column, signed]) => column !== signed);
    if (unsigned !== undefined) {
      throw new DecisionIntegrityError(
        `seq ${row.seq}: ${unsigned[0]} is not what the signature covers`,
      );
    }
  }

  const wanted = new Set(lineageIds);
  const returned = versioned.filter((row) => wanted.has(row.lineage_id));
  for (const row of returned) {
    if (row.gate_lineage_id !== row.lineage_id) {
      throw new DecisionIntegrityError(
        `seq ${row.seq}: lineage ${row.lineage_id} is not the lineage of gate ${row.gate_id}`,
      );
    }
  }
  return returned;
}

/**
 * Each bound column, its stored value and the value its row's signed payload
 * holds for it, in the order a failure names them. Only the fields a format
 * signed are here: a v1 or v2 row has no signed round to compare, and
 * pretending otherwise would fail every honest legacy row.
 */
function boundColumns(row: VerifiedDecision): readonly (readonly [string, unknown, unknown])[] {
  const signed = row.payload;
  const always = [
    ['gate_id', row.gate_id, signed['gate']],
    ['version_id', row.version_id, signed['version']],
    ['decision', row.decision, signed['decision']],
    ['decided_by_person_id', row.decided_by_person_id, signed['by']],
    ['evidence_digest', row.evidence_digest, signed['evidence']],
  ] as const;
  if (row.link_version !== 3) return always;
  return [
    ...always,
    ['id', row.id, signed['id']],
    ['seq', Number(row.seq), signed['seq']],
    ['prev_hash', row.prev_hash, signed['prev']],
    ['lineage_id', row.lineage_id, signed['lineage']],
    ['round', row.round, signed['round']],
    ['decided_by_actor_id', row.decided_by_actor_id, signed['actor']],
    ['decided_at', row.decided_at_text, signed['decidedAt']],
    ['signing_key_id', row.signing_key_id, signed['key']],
  ];
}

/** The gate state each decision moves its gate to (`decide.ts`). */
const DECIDED_STATE: Readonly<Record<string, string>> = {
  approve: 'approved',
  reject: 'rejected',
  request_changes: 'changes_requested',
};

interface GateFact {
  readonly id: string;
  readonly state: string;
  readonly round: number;
  readonly lineage_id: string;
  readonly lineage_state: string;
  readonly terminal_reason: string | null;
}

/**
 * U1: what the gates and lineages say was decided, against the decisions the
 * chain returned. Returns where they disagree, or `null` when they agree.
 */
async function missingDecisions(
  tx: TenantQuery,
  lineageIds: readonly string[],
  decisions: readonly VerifiedDecision[],
): Promise<string | null> {
  const gates = await tx.query<GateFact>(
    `select g.id, g.state, g.round, ver.lineage_id,
            lin.state as lineage_state, lin.terminal_reason
       from public.gates g
       join public.proposal_versions ver
         on ver.business_id = g.business_id and ver.id = g.version_id
       join public.proposal_lineages lin
         on lin.business_id = ver.business_id and lin.id = ver.lineage_id
      where g.business_id = $1 and ver.lineage_id = any($2::uuid[])
      order by g.round, g.id`,
    [tx.businessId, lineageIds],
  );
  return (
    gateWithoutItsDecision(gates, decisions) ??
    lineageIds.map((id) => lineageWithoutItsDecisions(id, gates, decisions)).find(Boolean) ??
    null
  );
}

/** A decided gate has the one decision that moved it, and that decision's state. */
function gateWithoutItsDecision(
  gates: readonly GateFact[],
  decisions: readonly VerifiedDecision[],
): string | null {
  const byGate = new Map(decisions.map((row) => [row.gate_id, row] as const));
  const decidedStates = new Set(Object.values(DECIDED_STATE));
  for (const gate of gates) {
    const decision = byGate.get(gate.id);
    if (decidedStates.has(gate.state) && decision === undefined) {
      return `gate ${gate.id} is ${gate.state} and has no decision that moved it there`;
    }
    if (decision !== undefined && DECIDED_STATE[decision.decision] !== gate.state) {
      return `seq ${decision.seq}: gate ${gate.id} is ${gate.state}, not what the decision made it`;
    }
  }
  return null;
}

/** A rejected lineage has its rejection, and its rounds are accounted for. */
function lineageWithoutItsDecisions(
  lineageId: string,
  gates: readonly GateFact[],
  decisions: readonly VerifiedDecision[],
): string | null {
  const own = gates.filter((gate) => gate.lineage_id === lineageId);
  const mine = decisions.filter((row) => row.lineage_id === lineageId);
  const first = own[0];
  if (
    first?.lineage_state === 'rejected' &&
    first.terminal_reason === 'gate_rejected' &&
    !mine.some((row) => row.decision === 'reject')
  ) {
    return `lineage ${lineageId} was rejected at a gate and has no rejection`;
  }
  // Round n is reached only through n - 1 requested changes on the lineage
  // (`proposal-writer.ts`, `roundsUsed`), so a later round with fewer is a
  // lineage whose requests were removed.
  const requested = mine.filter((row) => row.decision === 'request_changes').length;
  const highest = Math.max(0, ...own.map((gate) => gate.round));
  if (highest - 1 > requested) {
    return `lineage ${lineageId} has a round ${highest} gate and ${requested} requested changes`;
  }
  return null;
}

/**
 * The prefix of the business chain that ends at the newest decision on these
 * lineages. One statement, so the prefix and the rows it verifies are the same
 * snapshot.
 */
async function readChainPrefix(
  tx: TenantQuery,
  lineageIds: readonly string[],
): Promise<readonly VerifiedDecisionRow[]> {
  return await tx.query<VerifiedDecisionRow>(
    `with wanted as (
       select max(seq) as last from public.gate_decisions
        where business_id = $1 and lineage_id = any($2::uuid[])
     )
     select d.lineage_id, ver.lineage_id as gate_lineage_id,
            d.id, d.seq::text as seq, d.gate_id, d.version_id, d.decision, d.round,
            d.decided_by_person_id, d.decided_by_actor_id, d.decided_at,
            ${decidedAtText('d.decided_at')} as decided_at_text, d.evidence_digest,
            d.payload, d.payload_digest, d.signing_key_id, d.signature, d.prev_hash, d.hash
       from public.gate_decisions d
       cross join wanted
       left join public.gates g
         on g.business_id = d.business_id and g.id = d.gate_id
       left join public.proposal_versions ver
         on ver.business_id = g.business_id and ver.id = g.version_id
      where d.business_id = $1 and d.seq <= wanted.last
      order by d.seq`,
    [tx.businessId, lineageIds],
  );
}

/**
 * The fields `decide` links, in its names, at the row's own link version. A
 * field added there and not here fails every read, which is the loud
 * direction to be wrong in.
 */
function linkFields(row: { readonly seq: number | bigint }): Record<string, unknown> {
  const full = row as unknown as VerifiedDecision;
  return decisionLink(full.link_version, {
    id: full.id,
    seq: Number(full.seq),
    gate: full.gate_id,
    version: full.version_id,
    decision: full.decision,
    person: full.decided_by_person_id,
    payloadDigest: full.payload_digest,
    signature: full.signature,
    round: full.round,
    decidedAt: full.decided_at_text,
    lineage: full.lineage_id,
    actor: full.decided_by_actor_id,
    evidence: full.evidence_digest,
    key: full.signing_key_id,
  });
}
