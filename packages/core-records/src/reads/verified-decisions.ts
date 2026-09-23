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
// One check sits beside `verifyChain`, because the link does not cover the
// column: each returned row's `lineage_id` must be the lineage its gate's
// version belongs to. The gate and version are covered by the hash; the
// lineage column, which is what this read filters on, is not.

import type { TenantQuery } from '../tenancy/database.ts';
import { type SigningKey, verifyChain } from '../../../core-runtime/src/signing.ts';

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
  readonly decided_at: Date;
  readonly payload: Record<string, unknown>;
  readonly payload_digest: string;
  readonly signing_key_id: string;
  readonly signature: string;
  readonly prev_hash: string;
  readonly hash: string;
}

/**
 * The decisions on these lineages, oldest first, each verified along the
 * business chain. Throws `DecisionIntegrityError` rather than return one that
 * does not hold.
 */
export async function readVerifiedDecisions(
  tx: TenantQuery,
  lineageIds: readonly string[],
  signingKey: SigningKey | null,
): Promise<readonly VerifiedDecisionRow[]> {
  if (lineageIds.length === 0) return [];

  const chain = await readChainPrefix(tx, lineageIds);
  if (chain.length === 0) return [];

  if (signingKey === null) {
    throw new DecisionIntegrityError(
      'no signing key is configured, so the stored decisions cannot be verified',
    );
  }

  const broken = verifyChain(
    signingKey,
    chain.map((row) => ({ ...row, seq: Number(row.seq) })),
    linkFields,
  );
  if (broken !== null) throw new DecisionIntegrityError(broken);

  const wanted = new Set(lineageIds);
  const returned = chain.filter((row) => wanted.has(row.lineage_id));
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
            d.decided_by_person_id, d.decided_at, d.payload, d.payload_digest,
            d.signing_key_id, d.signature, d.prev_hash, d.hash
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
 * The fields `decide` links, in its names. A field added there and not here
 * fails every read, which is the loud direction to be wrong in.
 */
function linkFields(row: { readonly seq: number | bigint }): Record<string, unknown> {
  const full = row as unknown as VerifiedDecisionRow;
  return {
    id: full.id,
    seq: Number(full.seq),
    gate: full.gate_id,
    version: full.version_id,
    decision: full.decision,
    person: full.decided_by_person_id,
    payloadDigest: full.payload_digest,
    signature: full.signature,
  };
}
