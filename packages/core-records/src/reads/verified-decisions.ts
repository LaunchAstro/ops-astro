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
// **The evidence a decision signed is the version and pack the read shows.**
// The signed evidence digest is the only signed carrier of the ceiling and
// currency a decision approved (`evidence.ts`, `bound`), and neither the
// version, the pack nor the gate's binding is append-only. So beside the
// lineage check each returned row's gate must still be bound to the row's own
// version and pack; that version's pack must hold the digest the decision
// signed, and its stored body must still hash to that digest; and the body's
// version number, lineage, ceiling and currency must be the version row's.
// A gate moved onto another version, a pack body rewritten under its old
// digest or a version's ceiling rewritten fails as a broken link does. A
// gate is per version (`gates_version_idx`) and so is a pack, so a decision
// on a version later superseded stays bound to that version.
//
// **A chain cannot see what was never in it.** Removing the newest decisions
// in a business leaves a shorter chain that verifies from genesis to its new
// head. So the read also checks the decisions against what the gates and
// lineages say happened (U1): a gate stored `approved`, `rejected` or
// `changes_requested` has exactly the one decision that moved it; a decision
// has the gate state it produced; a rejected lineage has its rejection; and a
// lineage's gates never reach a round its requested changes do not account
// for. Any of these missing is the same named failure as a broken link.
//
// **The chain and the facts it is checked against are one snapshot.** The
// read runs in an ordinary read-committed transaction, where each statement
// sees what was committed when it began. A chain read before a `task.decide`
// commits and a gate read after it would disagree about intact evidence: an
// approved gate with no decision, a fault on a decision nobody touched. So the
// chain prefix and the gate and lineage facts come from one statement, and the
// read answers the old view or the new one, never a mix. A read that shows
// rows beside the decisions, such as a gate's state, takes them in that same
// statement (`readVerifiedProjection`): a gate read before the decide and a
// decision read after it would show `pending` beside a verified `approve`.

import type { TenantQuery } from '../tenancy/database.ts';
import {
  type KeyResolver,
  type LinkVersion,
  type SigningKey,
  decidedAtText,
  decisionLink,
  digestOf,
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

/**
 * What the read shows beside a decision: its gate's binding, and its own
 * version and that version's evidence pack. Null where a join found nothing.
 * The version and pack are joined only for rows on the scope's lineages, the
 * rows `verified` returns and checks, so a long business chain does not carry
 * every pack body the business ever rendered.
 */
interface BoundEvidence {
  readonly gate_version_id: string | null;
  readonly gate_evidence_pack_id: string | null;
  readonly dv_version: number | null;
  readonly dv_lineage_id: string | null;
  readonly dv_maximum_minor: string | null;
  readonly dv_currency: string | null;
  readonly dp_id: string | null;
  readonly dp_rendered: Record<string, unknown> | null;
  readonly dp_rendered_digest: string | null;
}

/** A verified row and the link version it verified under. */
export interface VerifiedDecision extends VerifiedDecisionRow {
  readonly link_version: LinkVersion;
}

/** A row as `verifyChain` walks it: `seq` is a number rather than its text. */
type ChainedDecision = Omit<VerifiedDecision, 'seq'> & { readonly seq: number };

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
  const scope = {
    lineages: 'select unnest($2::uuid[]) as lineage_id',
    rows: {},
    parameter: lineageIds,
  };
  return (await readVerifiedProjection(tx, scope, keys)).decisions;
}

/**
 * A read's own rows, taken in the statement that takes the chain, so what the
 * read shows beside its decisions is the same snapshot as they are.
 *
 * `lineages` selects the column `lineage_id`, the lineages in scope; each
 * entry of `rows` selects the rows of one shape, with an `ordinal` column that
 * orders them. Both use `$1` for the business and `$2` for `parameter`. The
 * rows come back as JSON: a timestamp is its text, and a caller wanting a
 * number from a `bigint` selects it as text.
 */
export interface ProjectionScope {
  readonly lineages: string;
  readonly rows: Readonly<Record<string, string>>;
  readonly parameter: unknown;
}

export interface VerifiedProjection {
  /** The lineages in scope, in this snapshot. */
  readonly lineageIds: readonly string[];
  readonly decisions: readonly VerifiedDecision[];
  /** Each entry of `rows`, in `ordinal` order. */
  readonly rows: Readonly<Record<string, readonly unknown[]>>;
}

/**
 * The decisions on the lineages a scope names, verified as
 * `readVerifiedDecisions` verifies them, with the scope's rows from the same
 * snapshot. Throws `DecisionIntegrityError` rather than return a decision that
 * does not hold.
 */
export async function readVerifiedProjection(
  tx: TenantQuery,
  scope: ProjectionScope,
  keys: KeyResolver | SigningKey | null,
): Promise<VerifiedProjection> {
  const { chain, gates, lineageIds, rows } = await readSnapshot(tx, scope);
  const returned = chain.length === 0 ? [] : verified(chain, lineageIds, keys);
  const missing = missingDecisions(lineageIds, gates, returned);
  if (missing !== null) throw new DecisionIntegrityError(missing);
  return { lineageIds, decisions: returned, rows };
}

/** The chain walked under each row's own link version and key, then filtered to the lineages. */
function verified(
  chain: readonly ChainRow[],
  lineageIds: readonly string[],
  keys: KeyResolver | SigningKey | null,
): readonly VerifiedDecision[] {
  if (keys === null) {
    throw new DecisionIntegrityError(
      'no signing key is configured, so the stored decisions cannot be verified',
    );
  }
  const versioned: VerifiedDecision[] = [];
  const bound = new Map<string, BoundEvidence>();
  for (const [row, shown] of chain.map((stored) => splitShown(stored))) {
    const version = linkVersionOf(row.payload);
    if (version === undefined) {
      throw new DecisionIntegrityError(`seq ${row.seq}: the payload names an unknown link version`);
    }
    versioned.push(Object.assign({}, row, { link_version: version }));
    bound.set(row.id, shown);
  }
  const broken = verifyChain(
    keys,
    versioned.map((row): ChainedDecision => Object.assign({}, row, { seq: Number(row.seq) })),
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
    const unbound = unboundEvidence(row, bound.get(row.id));
    if (unbound !== null) throw new DecisionIntegrityError(`seq ${row.seq}: ${unbound}`);
  }
  return returned;
}

/** A chain row's decision columns, and apart from them what the read shows beside it. */
function splitShown({
  gate_version_id,
  gate_evidence_pack_id,
  dv_version,
  dv_lineage_id,
  dv_maximum_minor,
  dv_currency,
  dp_id,
  dp_rendered,
  dp_rendered_digest,
  ...row
}: ChainRow): readonly [VerifiedDecisionRow, BoundEvidence] {
  const shown = { gate_version_id, gate_evidence_pack_id, dv_version, dv_lineage_id };
  return [row, { ...shown, dv_maximum_minor, dv_currency, dp_id, dp_rendered, dp_rendered_digest }];
}

/**
 * Where the gate, version and pack the read shows stop being what the
 * decision signed, or `null` when they are. The signed evidence digest is
 * compared with the pack's, the pack's body is hashed again as `evidence.ts`
 * hashed it, and the body's fields are compared with the version row.
 */
function unboundEvidence(row: VerifiedDecision, shown: BoundEvidence | undefined): string | null {
  if (shown === undefined || shown.gate_version_id !== row.version_id) {
    return `gate ${row.gate_id} is bound to version ${shown?.gate_version_id ?? 'none'}, not the decision's version ${row.version_id}`;
  }
  if (shown.dp_id === null || shown.dp_rendered === null) {
    return `version ${row.version_id} has no evidence pack`;
  }
  if (shown.gate_evidence_pack_id !== shown.dp_id) {
    return `gate ${row.gate_id} is bound to another evidence pack than version ${row.version_id}'s`;
  }
  if (shown.dp_rendered_digest !== row.evidence_digest) {
    return `evidence pack ${shown.dp_id} is not the evidence the decision signed`;
  }
  if (digestOf(shown.dp_rendered) !== shown.dp_rendered_digest) {
    return `evidence pack ${shown.dp_id} does not match its own digest`;
  }
  const rendered = shown.dp_rendered;
  const signed = rendered['bound'] as Record<string, unknown> | null | undefined;
  const fields = [
    ['version', shown.dv_version, rendered['version']],
    ['lineage_id', shown.dv_lineage_id, rendered['lineage']],
    ['maximum_minor', Number(shown.dv_maximum_minor), signed?.['maximumMinor']],
    ['currency', shown.dv_currency, signed?.['currency']],
  ] as const;
  const differs = fields.find(([, column, evidence]) => column !== evidence);
  return differs === undefined
    ? null
    : `version ${row.version_id}'s ${differs[0]} is not what the signed evidence bound`;
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
 * `gates` must come from the same snapshot as the chain (`readSnapshot`).
 */
function missingDecisions(
  lineageIds: readonly string[],
  gates: readonly GateFact[],
  decisions: readonly VerifiedDecision[],
): string | null {
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

/** True on the statement's first row: the oldest chain row, or the only row of an empty chain. */
const FIRST_ROW = 'lag(chain.chain_position) over (order by chain.chain_position) is null';

/** A chain row as the snapshot reads it: the decision and what the read shows beside it. */
type ChainRow = VerifiedDecisionRow & BoundEvidence;

/** A chain row with the snapshot's facts beside it; `id` is null when the chain is empty. */
interface SnapshotRow extends Omit<ChainRow, 'id'> {
  readonly id: string | null;
  readonly chain_position: string | null;
  readonly snapshot_gates: readonly GateFact[];
  /** On the first row only; null on the others. */
  readonly snapshot_lineages: readonly string[] | null;
  readonly snapshot_rows: Readonly<Record<string, readonly unknown[]>> | null;
}

/**
 * The prefix of the business chain that ends at the newest decision on the
 * scope's lineages, the gate and lineage facts U1 checks it against, oldest
 * gate round first, and the scope's own rows. One statement, so the prefix,
 * the rows it verifies, the facts and what the read shows beside them are one
 * snapshot.
 *
 * The facts and rows are aggregates beside the chain rows, so an empty chain
 * still brings them: the snapshot row survives the left join with every chain
 * column null, and is dropped here. The scope's rows ride on the first row
 * only, since the chain prefix can be the business's whole history.
 */
async function readSnapshot(
  tx: TenantQuery,
  scope: ProjectionScope,
): Promise<{
  readonly chain: readonly ChainRow[];
  readonly gates: readonly GateFact[];
  readonly lineageIds: readonly string[];
  readonly rows: Readonly<Record<string, readonly unknown[]>>;
}> {
  const names = Object.keys(scope.rows);
  const projected = names.map((name, index) => ({ name, cte: `projected_${index}` }));
  const rows = await tx.query<SnapshotRow>(
    `with lineages as (${scope.lineages}),
     ${projected.map(({ name, cte }) => `${cte} as (${scope.rows[name]}),`).join('\n     ')}
     wanted as (
       select max(seq) as last from public.gate_decisions
        where business_id = $1 and lineage_id in (select lineage_id from lineages)
     ),
     facts as (
       select coalesce(json_agg(json_build_object(
                'id', g.id, 'state', g.state, 'round', g.round,
                'lineage_id', ver.lineage_id, 'lineage_state', lin.state,
                'terminal_reason', lin.terminal_reason)
              order by g.round, g.id), '[]'::json) as snapshot_gates
         from public.gates g
         join public.proposal_versions ver
           on ver.business_id = g.business_id and ver.id = g.version_id
         join public.proposal_lineages lin
           on lin.business_id = ver.business_id and lin.id = ver.lineage_id
        where g.business_id = $1 and ver.lineage_id in (select lineage_id from lineages)
     ),
     scoped as (
       select coalesce(array_agg(lineage_id::text), '{}') as snapshot_lineages from lineages
     )
     select facts.snapshot_gates,
            case when ${FIRST_ROW} then scoped.snapshot_lineages end as snapshot_lineages,
            case when ${FIRST_ROW} then json_build_object(${projected
              .map(
                ({ cte }, index) =>
                  `$${index + 3}::text, (select coalesce(json_agg(p order by p.ordinal), '[]'::json) from ${cte} p)`,
              )
              .join(', ')}) end as snapshot_rows,
            chain.*
       from facts
       cross join scoped
       left join lateral (
         select d.lineage_id, ver.lineage_id as gate_lineage_id,
                d.id, d.seq::text as seq, d.seq as chain_position, d.gate_id, d.version_id,
                d.decision, d.round, d.decided_by_person_id, d.decided_by_actor_id, d.decided_at,
                ${decidedAtText('d.decided_at')} as decided_at_text, d.evidence_digest,
                d.payload, d.payload_digest, d.signing_key_id, d.signature, d.prev_hash, d.hash,
                g.version_id as gate_version_id, g.evidence_pack_id as gate_evidence_pack_id,
                dv.version as dv_version, dv.lineage_id as dv_lineage_id,
                dv.maximum_minor::text as dv_maximum_minor, dv.currency as dv_currency,
                dp.id as dp_id, dp.rendered as dp_rendered, dp.rendered_digest as dp_rendered_digest
           from public.gate_decisions d
           cross join wanted
           left join public.gates g
             on g.business_id = d.business_id and g.id = d.gate_id
           left join public.proposal_versions ver
             on ver.business_id = g.business_id and ver.id = g.version_id
           left join public.proposal_versions dv
             on dv.business_id = d.business_id and dv.id = d.version_id
            and d.lineage_id in (select lineage_id from lineages)
           left join public.evidence_packs dp
             on dp.business_id = d.business_id and dp.version_id = d.version_id
            and d.lineage_id in (select lineage_id from lineages)
          where d.business_id = $1 and d.seq <= wanted.last
       ) chain on true
      order by chain.chain_position`,
    [tx.businessId, scope.parameter, ...names],
  );
  const first = rows[0];
  const chain = rows
    .filter((row): row is SnapshotRow & { readonly id: string } => row.id !== null)
    .map(
      ({
        snapshot_gates: _gates,
        snapshot_lineages: _lineages,
        snapshot_rows: _rows,
        chain_position: _position,
        ...row
      }) => row,
    );
  return {
    chain,
    gates: first?.snapshot_gates ?? [],
    lineageIds: first?.snapshot_lineages ?? [],
    rows: first?.snapshot_rows ?? {},
  };
}

/**
 * The fields `decide` links, in its names, at the row's own link version. A
 * field added there and not here fails every read, which is the loud
 * direction to be wrong in.
 */
function linkFields(row: ChainedDecision): Record<string, unknown> {
  return decisionLink(row.link_version, {
    id: row.id,
    seq: row.seq,
    gate: row.gate_id,
    version: row.version_id,
    decision: row.decision,
    person: row.decided_by_person_id,
    payloadDigest: row.payload_digest,
    signature: row.signature,
    round: row.round,
    decidedAt: row.decided_at_text,
    lineage: row.lineage_id,
    actor: row.decided_by_actor_id,
    evidence: row.evidence_digest,
    key: row.signing_key_id,
  });
}
