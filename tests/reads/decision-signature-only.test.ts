// SPDX-License-Identifier: AGPL-3.0-only
//
// G02 (a): one decision's stored signature altered, and nothing else.
//
// LEDGER:87 asks for payload, signature and chain tampering. The payload and
// the chain have cases of their own (`decision-integrity-read.test.ts`,
// `verified-decisions.test.ts`); this suite changes `gate_decisions.signature`
// alone and reads the task through the production HTTP read and directly:
//
// - with the stored `hash` left as it was, the read is the named fault;
// - with the unkeyed chain recomputed over the new signature, so `prev_hash`
//   and `hash` agree with the altered row, it is still the named fault: the
//   chain is a hash anyone can recompute, and only the keyed signature says
//   who wrote the payload;
// - with the original signature and hash put back, the same read answers.
//
// Tampering is done as the database owner, with the append-only triggers off
// for the one statement, as in the suites above.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTaskProposals } from '../../packages/core-records/src/reads/proposals.ts';
import { DecisionIntegrityError } from '../../packages/core-records/src/reads/verified-decisions.ts';
import {
  chainHash,
  decidedAtText,
  decisionLink,
  linkVersionOf,
} from '../../packages/core-runtime/src/signing.ts';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';

interface StoredRow {
  readonly id: string;
  readonly seq: string;
  readonly gate_id: string;
  readonly version_id: string;
  readonly lineage_id: string;
  readonly decision: string;
  readonly round: number;
  readonly decided_by_person_id: string;
  readonly decided_by_actor_id: string;
  readonly decided_at_text: string;
  readonly evidence_digest: string;
  readonly payload: Record<string, unknown>;
  readonly payload_digest: string;
  readonly signing_key_id: string;
  readonly signature: string;
  readonly prev_hash: string;
  readonly hash: string;
}

const asAda = async (world: World, name: string, body: Readonly<Record<string, unknown>>) =>
  await call(world.api, personPath('alpha', name), body, bearer(world.ada.token));

async function onlyRow(world: World): Promise<StoredRow> {
  const rows = await world.db.admin.execute<StoredRow>(
    `select id, seq::text as seq, gate_id, version_id, lineage_id, decision, round,
            decided_by_person_id, decided_by_actor_id, evidence_digest, payload,
            payload_digest, signing_key_id, signature, prev_hash, hash,
            ${decidedAtText('decided_at')} as decided_at_text
       from public.gate_decisions where business_id = $1 order by seq`,
    [world.alpha],
  );
  expect(rows).toHaveLength(1);
  return rows[0] as StoredRow;
}

/** The unkeyed link for `row` with `signature` in place of its own. */
function hashWith(row: StoredRow, signature: string): string {
  const version = linkVersionOf(row.payload);
  if (version === undefined) throw new Error('signature-only: unknown link version');
  return chainHash(
    row.prev_hash,
    decisionLink(version, {
      id: row.id,
      seq: Number(row.seq),
      gate: row.gate_id,
      version: row.version_id,
      decision: row.decision,
      person: row.decided_by_person_id,
      payloadDigest: row.payload_digest,
      signature,
      round: row.round,
      decidedAt: row.decided_at_text,
      lineage: row.lineage_id,
      actor: row.decided_by_actor_id,
      evidence: row.evidence_digest,
      key: row.signing_key_id,
    }),
  );
}

/** Set the row's signature (and, if given, its hash) as the owner, triggers off. */
async function store(world: World, id: string, signature: string, hash?: string): Promise<void> {
  await world.db.admin.execute('alter table public.gate_decisions disable trigger all');
  try {
    await world.db.admin.execute(
      hash === undefined
        ? 'update public.gate_decisions set signature = $3 where business_id = $1 and id = $2'
        : 'update public.gate_decisions set signature = $3, hash = $4 where business_id = $1 and id = $2',
      hash === undefined ? [world.alpha, id, signature] : [world.alpha, id, signature, hash],
    );
  } finally {
    await world.db.admin.execute('alter table public.gate_decisions enable trigger all');
  }
}

/** The same length and alphabet, one character different. */
const altered = (signature: string): string =>
  `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;

async function readOver(world: World, taskId: string) {
  return await asAda(world, '/task/read', { operationId: randomUUID(), recordId: taskId });
}

async function readDirect(world: World, taskId: string): Promise<unknown> {
  try {
    await world.db.app.withBusiness(world.alpha, async (tx) => await readTaskProposals(tx, taskId));
    return null;
  } catch (cause) {
    return cause;
  }
}

if (serverUrl === undefined) {
  console.warn('reads/decision-signature-only: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('G02 (a): only gate_decisions.signature altered', () => {
  let world: World;
  let taskId: string;
  let original: StoredRow;

  beforeAll(async () => {
    world = await createWorld('dsig');
    const created = await asAda(world, '/task/create', {
      operationId: randomUUID(),
      fields: { title: `a decision whose signature is changed ${randomUUID()}` },
    });
    expect(created.code, 'create').toBe('ok');
    taskId = String(created.body['recordId']);
    const revisions = await world.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where business_id = $1 and id = $2',
      [world.alpha, taskId],
    );
    const proposed = await asAda(world, '/task/propose', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: Number(revisions[0]?.revision ?? '0'),
      purpose: 'draft_the_reply',
      maximumMinor: 1500,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    });
    expect(proposed.code, 'propose').toBe('ok');
    const detail = proposed.body['detail'] as Record<string, string>;
    const decided = await asAda(world, '/task/decide', {
      operationId: randomUUID(),
      gateId: detail['gateId'],
      versionId: detail['versionId'],
      decision: 'approve',
      note: 'approve as proposed',
    });
    expect(decided.code, 'decide').toBe('ok');
    original = await onlyRow(world);
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  it('reads the untouched decision, as the positive control', async () => {
    const answer = await readOver(world, taskId);
    expect(answer.status).toBe(200);
    expect(await readDirect(world, taskId)).toBeNull();
    expect(hashWith(original, original.signature)).toBe(original.hash);
  });

  it('faults DECISION_INTEGRITY when only the signature changed', async () => {
    await store(world, original.id, altered(original.signature));
    const row = await onlyRow(world);
    // Only the signature moved.
    expect({ ...row, signature: original.signature }).toStrictEqual(original);
    expect(row.signature).not.toBe(original.signature);

    const answer = await readOver(world, taskId);
    expect({ status: answer.status, code: answer.body['code'] }).toStrictEqual({
      status: 500,
      code: 'DECISION_INTEGRITY',
    });
    const failure = await readDirect(world, taskId);
    expect(failure).toBeInstanceOf(DecisionIntegrityError);
    expect((failure as Error).message).toMatch(/signature does not verify/u);
  }, 60_000);

  it('still faults when the unkeyed chain is recomputed over the altered signature', async () => {
    const forged = altered(original.signature);
    const rehashed = hashWith(original, forged);
    await store(world, original.id, forged, rehashed);
    const row = await onlyRow(world);
    // The chain now holds for the altered row: prev_hash is genesis's link,
    // the hash covers the new signature, and there is no later row to break.
    expect(row.hash).toBe(hashWith(row, row.signature));
    expect(row.hash).not.toBe(original.hash);
    expect({ ...row, signature: original.signature, hash: original.hash }).toStrictEqual(original);

    const answer = await readOver(world, taskId);
    expect({ status: answer.status, code: answer.body['code'] }).toStrictEqual({
      status: 500,
      code: 'DECISION_INTEGRITY',
    });
    const failure = await readDirect(world, taskId);
    expect(failure).toBeInstanceOf(DecisionIntegrityError);
    expect((failure as Error).message).toMatch(/signature does not verify/u);
  }, 60_000);

  it('answers again once the original signature and hash are restored', async () => {
    await store(world, original.id, original.signature, original.hash);
    expect(await onlyRow(world)).toStrictEqual(original);
    const answer = await readOver(world, taskId);
    expect(answer.status).toBe(200);
    expect(await readDirect(world, taskId)).toBeNull();
  }, 60_000);
});
