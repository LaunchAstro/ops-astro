// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, lane FR1-API-SIGN, the read half: the signing fixes
// seen through the production HTTP read and the direct read.
//
// - R1-RUNTIME-50: a stored signature changed only in spelling (uppercased,
//   with junk or an odd nibble appended) and the unkeyed chain recomputed over
//   it is the named fault, as a changed byte already was.
// - R1-RUNTIME-51: a stored payload that is not a JSON object is
//   `DECISION_INTEGRITY` 500, never the retryable `SERVICE_UNAVAILABLE`.
// - R1-RUNTIME-52: a note whose object carries an own `__proto__` member,
//   altered under that member with its old digest, signature and hash, is the
//   named fault. `task.decide` refuses a note that is not a string (#53), so
//   that decision is written here as a stored row, correctly signed, the way
//   one written before that refusal, or by a later payload version, would be.
//
// Tampering is done as the database owner, with the append-only triggers off
// for the one statement, as in `decision-signature-only.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTaskProposals } from '../../packages/core-records/src/reads/proposals.ts';
import { DecisionIntegrityError } from '../../packages/core-records/src/reads/verified-decisions.ts';
import { gateSigningKey } from '../../packages/core-records/src/commands/runtime-config.ts';
import {
  chainHash,
  decidedAtText,
  decisionLink,
  digestOf,
  linkVersionOf,
  sign,
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
  readonly payload_text: string;
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
            payload::text as payload_text, payload_digest, signing_key_id, signature,
            prev_hash, hash, ${decidedAtText('decided_at')} as decided_at_text
       from public.gate_decisions where business_id = $1 order by seq`,
    [world.alpha],
  );
  expect(rows).toHaveLength(1);
  return rows[0] as StoredRow;
}

/** The unkeyed link for `row` with `signature` in place of its own. */
function hashWith(row: StoredRow, signature: string): string {
  const version = linkVersionOf(row.payload);
  if (version === undefined) throw new Error('final-r1-api-sign: unknown link version');
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

/**
 * One statement as the owner, with the append-only triggers off for it. JSON
 * goes in as `$n::text::jsonb`: bound straight to `jsonb`, the driver encodes
 * a string parameter as a JSON string.
 */
async function tamper(world: World, text: string, parameters: readonly unknown[]): Promise<void> {
  await world.db.admin.execute('alter table public.gate_decisions disable trigger all');
  try {
    await world.db.admin.execute(text, parameters);
  } finally {
    await world.db.admin.execute('alter table public.gate_decisions enable trigger all');
  }
}

async function restore(world: World, row: StoredRow): Promise<void> {
  await tamper(
    world,
    `update public.gate_decisions set payload = $3::text::jsonb, signature = $4, hash = $5
      where business_id = $1 and id = $2`,
    [world.alpha, row.id, row.payload_text, row.signature, row.hash],
  );
}

async function readOver(world: World, taskId: string) {
  const answer = await asAda(world, '/task/read', {
    operationId: randomUUID(),
    recordId: taskId,
  });
  return { status: answer.status, code: answer.body['code'] };
}

async function readDirect(world: World, taskId: string): Promise<unknown> {
  try {
    await world.db.app.withBusiness(world.alpha, async (tx) => await readTaskProposals(tx, taskId));
    return null;
  } catch (cause) {
    return cause;
  }
}

/**
 * Rewrites the one stored decision, as the owner, into a correctly signed
 * decision whose note is `note`: a new payload digest, a signature under the
 * world's own key and the chain hash recomputed over both. The read verifies
 * it as it would any decision the server wrote.
 */
async function storeNote(world: World, note: unknown): Promise<void> {
  const row = await onlyRow(world);
  const key = gateSigningKey();
  if (key?.id !== row.signing_key_id) throw new Error('final-r1-api-sign: not the world key');
  const payload = { ...row.payload, note };
  const payloadDigest = digestOf(payload);
  const signature = sign(key, payloadDigest);
  await tamper(
    world,
    `update public.gate_decisions
        set payload = $3::text::jsonb, payload_digest = $4, signature = $5, hash = $6
      where business_id = $1 and id = $2`,
    [
      world.alpha,
      row.id,
      JSON.stringify(payload),
      payloadDigest,
      signature,
      hashWith({ ...row, payload_digest: payloadDigest }, signature),
    ],
  );
}

/** A task with one proposal and one approval, whose note is `note`. */
async function decidedTask(world: World, note: string): Promise<string> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `final-r1-api-sign ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  const taskId = String(created.body['recordId']);
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
    note,
  });
  expect(decided.code, 'decide').toBe('ok');
  return taskId;
}

const FAULT = { status: 500, code: 'DECISION_INTEGRITY' };

if (serverUrl === undefined) {
  console.warn('reads/final-r1-api-sign-read: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('R1-RUNTIME-50 and -51 over the read', () => {
  let world: World;
  let taskId: string;
  let original: StoredRow;

  beforeAll(async () => {
    world = await createWorld('fsg');
    taskId = await decidedTask(world, 'approve as proposed');
    original = await onlyRow(world);
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  it('reads the untouched decision, as the positive control', async () => {
    expect((await readOver(world, taskId)).status).toBe(200);
    expect(await readDirect(world, taskId)).toBeNull();
  });

  it.each([
    ['uppercased', (s: string) => s.toUpperCase()],
    ['with trailing non-hex', (s: string) => `${s}zz`],
    ['with an odd trailing nibble', (s: string) => `${s}0`],
  ])(
    'R1-RUNTIME-50: a signature %s, with the chain recomputed over it, is the named fault',
    async (_label, respell) => {
      const forged = respell(original.signature);
      await tamper(
        world,
        'update public.gate_decisions set signature = $3, hash = $4 where business_id = $1 and id = $2',
        [world.alpha, original.id, forged, hashWith(original, forged)],
      );
      try {
        const row = await onlyRow(world);
        expect(row.signature).toBe(forged);
        expect(row.hash).toBe(hashWith(row, row.signature));
        expect(await readOver(world, taskId)).toStrictEqual(FAULT);
        const failure = await readDirect(world, taskId);
        expect(failure).toBeInstanceOf(DecisionIntegrityError);
        expect((failure as Error).message).toMatch(/signature does not verify/u);
      } finally {
        await restore(world, original);
      }
      expect((await readOver(world, taskId)).status).toBe(200);
    },
    60_000,
  );

  it.each([['null'], ['"x"'], ['1'], ['[]']])(
    'R1-RUNTIME-51: a stored payload of %s is DECISION_INTEGRITY, not a retry',
    async (json) => {
      await tamper(
        world,
        'update public.gate_decisions set payload = $3::text::jsonb where business_id = $1 and id = $2',
        [world.alpha, original.id, json],
      );
      try {
        expect(await readOver(world, taskId)).toStrictEqual(FAULT);
        const failure = await readDirect(world, taskId);
        expect(failure).toBeInstanceOf(DecisionIntegrityError);
        expect((failure as Error).message).toMatch(/unknown link version/u);
      } finally {
        await restore(world, original);
      }
      expect((await readOver(world, taskId)).status).toBe(200);
    },
    60_000,
  );
});

describe.skipIf(serverUrl === undefined)('R1-RUNTIME-52 over the read', () => {
  let world: World;
  let taskId: string;
  let original: StoredRow;

  beforeAll(async () => {
    world = await createWorld('fsp');
    taskId = await decidedTask(world, 'approve as proposed');
    // Parsed, so `__proto__` is an own member as it is off the wire.
    await storeNote(world, JSON.parse('{"__proto__":{"reason":"approve 10"}}'));
    original = await onlyRow(world);
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  it('stores the __proto__ member and reads the untouched decision', async () => {
    expect(original.payload_text).toContain('"__proto__": {"reason": "approve 10"}');
    expect((await readOver(world, taskId)).status).toBe(200);
  });

  it('faults when only the value under __proto__ changed', async () => {
    await tamper(
      world,
      `update public.gate_decisions
          set payload = jsonb_set(payload, '{note,__proto__,reason}', '"approve 10000"')
        where business_id = $1 and id = $2`,
      [world.alpha, original.id],
    );
    try {
      const row = await onlyRow(world);
      expect(row.payload_text).toContain('"approve 10000"');
      expect(row.payload_digest).toBe(original.payload_digest);
      expect(await readOver(world, taskId)).toStrictEqual(FAULT);
      expect(await readDirect(world, taskId)).toBeInstanceOf(DecisionIntegrityError);
    } finally {
      await restore(world, original);
    }
    expect((await readOver(world, taskId)).status).toBe(200);
  }, 60_000);
});
