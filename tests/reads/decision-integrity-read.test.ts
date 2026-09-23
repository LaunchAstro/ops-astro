// SPDX-License-Identifier: AGPL-3.0-only
//
// What the proposal read does when the stored decisions do not hold, over the
// production HTTP read (`createApi` + `executeRead`, as `world.ts` composes it).
//
// Four gaps `verified-decisions.test.ts` left open, one block each:
//
// - **the v2 link** covers a decision's round, time, lineage, acting actor and
//   evidence digest, so altering any one of them fails the read; a v1 row
//   written before the change still verifies and is reported as v1;
// - **the key resolver** verifies a row signed under a retained older key id
//   with that key, and fails one whose key id it does not know;
// - **the named fault** is `DECISION_INTEGRITY` under 500, with no stored
//   value in the body, the stored rows untouched and no audit row left behind;
// - **U1**: a gate stored as decided with no decision, and a lineage whose
//   newest decisions were removed, fail the read although the shorter chain
//   verifies from genesis.
//
// Tampering is done as the database owner, with the append-only triggers off
// for the one statement, as in `verified-decisions.test.ts`. Each case gets its
// own world, so one broken chain does not leak into the next.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readTaskProposals } from '../../packages/core-records/src/reads/proposals.ts';
import { DecisionIntegrityError } from '../../packages/core-records/src/reads/verified-decisions.ts';
import {
  chainHash,
  decisionLink,
  digestOf,
  keyResolver,
  sign,
  type SigningKey,
} from '../../packages/core-runtime/src/signing.ts';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';

interface Decided {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
  readonly lineageId: string;
}

type Decision = 'approve' | 'reject' | 'request_changes';

const asAda = async (world: World, name: string, body: Readonly<Record<string, unknown>>) =>
  await call(world.api, personPath('alpha', name), body, bearer(world.ada.token));

async function revisionOf(world: World, recordId: string): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [world.alpha, recordId],
  );
  return Number(rows[0]?.revision ?? '0');
}

async function propose(world: World, taskId: string, lineageId?: string) {
  const proposed = await asAda(world, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
    purpose: 'draft_the_reply',
    maximumMinor: 1500,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
    ...(lineageId === undefined ? {} : { lineageId }),
  });
  expect(proposed.code, 'propose').toBe('ok');
  return proposed.body['detail'] as Record<string, string>;
}

/** A task, a proposal on it and one decision, all through the production path. */
async function decided(world: World, decision: Decision = 'approve'): Promise<Decided> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a decision worth checking ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  const taskId = String(created.body['recordId']);
  const detail = await propose(world, taskId);
  const gateId = String(detail['gateId']);
  const versionId = String(detail['versionId']);
  const answer = await asAda(world, '/task/decide', {
    operationId: randomUUID(),
    gateId,
    versionId,
    decision,
    note: `${decision} as proposed`,
  });
  expect(answer.code, 'decide').toBe('ok');
  return { taskId, gateId, versionId, lineageId: String(detail['lineageId']) };
}

async function readTask(world: World, taskId: string) {
  return await asAda(world, '/task/read', { operationId: randomUUID(), recordId: taskId });
}

function decisionsOf(answer: { readonly body: Record<string, unknown> }) {
  const task = answer.body['task'] as Record<string, unknown>;
  const proposals = task['proposals'] as readonly {
    readonly decisions: readonly Record<string, unknown>[];
  }[];
  return proposals.flatMap((proposal) => proposal.decisions);
}

/** One statement as the owner, with the append-only triggers off for it alone. */
async function tamper(world: World, sql: string, params: readonly unknown[]): Promise<void> {
  await world.db.admin.execute('alter table public.gate_decisions disable trigger all');
  try {
    await world.db.admin.execute(sql, params as unknown[]);
  } finally {
    await world.db.admin.execute('alter table public.gate_decisions enable trigger all');
  }
}

async function storedDecisions(world: World) {
  return await world.db.admin.execute<Record<string, unknown>>(
    `select * from public.gate_decisions where business_id = $1 order by seq`,
    [world.alpha],
  );
}

async function readAudits(world: World): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly count: string }>(
    `select count(*)::text as count from public.audit_events
      where business_id = $1 and command = 'task.read'`,
    [world.alpha],
  );
  return Number(rows[0]?.count ?? '0');
}

/** What a promise rejected with, or `null` if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (cause) {
    return cause;
  }
}

async function readDirect(
  world: World,
  taskId: string,
  keys?: Parameters<typeof readTaskProposals>[2],
) {
  return await world.db.app.withBusiness(world.alpha, async (tx) =>
    keys === undefined
      ? await readTaskProposals(tx, taskId)
      : await readTaskProposals(tx, taskId, keys),
  );
}

/** The HTTP answer is the named fault, and the direct read names where it broke. */
async function expectIntegrityFault(world: World, taskId: string, where: RegExp) {
  const answer = await readTask(world, taskId);
  expect(answer.status, 'a fault, under 500').toBe(500);
  expect(answer.body['code']).toBe('DECISION_INTEGRITY');
  expect(answer.body['refused']).toBeUndefined();
  expect(answer.body['task']).toBeUndefined();

  const failure = await rejectionOf(readDirect(world, taskId));
  expect(failure).toBeInstanceOf(DecisionIntegrityError);
  expect((failure as Error).message).toMatch(where);
}

function configuredKey(): SigningKey {
  return {
    id: process.env['GATE_SIGNING_KEY_ID'] ?? '',
    secret: process.env['GATE_SIGNING_SECRET'] ?? '',
  };
}

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
  readonly decided_at: string;
  readonly evidence_digest: string;
  readonly payload: Record<string, unknown>;
  readonly payload_digest: string;
  readonly prev_hash: string;
}

async function onlyRow(world: World): Promise<StoredRow> {
  const rows = await world.db.admin.execute<StoredRow>(
    `select id, seq::text as seq, gate_id, version_id, lineage_id, decision, round,
            decided_by_person_id, decided_by_actor_id, evidence_digest, payload,
            payload_digest, prev_hash,
            to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as decided_at
       from public.gate_decisions where business_id = $1 order by seq`,
    [world.alpha],
  );
  expect(rows).toHaveLength(1);
  return rows[0] as StoredRow;
}

/**
 * Re-sign the business's one decision as it would have been stored under
 * `version` and `key`, the way a restore of an older deployment's rows would
 * hold it. This is the fixture for a row this code did not write.
 */
async function restoreAs(world: World, version: 1 | 2, key: SigningKey): Promise<void> {
  const row = await onlyRow(world);
  const payload: Record<string, unknown> = { ...row.payload };
  if (version === 1) delete payload['link'];
  else payload['link'] = 2;
  const payloadDigest = digestOf(payload);
  const signature = sign(key, payloadDigest);
  const hash = chainHash(
    row.prev_hash,
    decisionLink(version, {
      id: row.id,
      seq: Number(row.seq),
      gate: row.gate_id,
      version: row.version_id,
      decision: row.decision,
      person: row.decided_by_person_id,
      payloadDigest,
      signature,
      round: row.round,
      decidedAt: row.decided_at,
      lineage: row.lineage_id,
      actor: row.decided_by_actor_id,
      evidence: row.evidence_digest,
      key: key.id,
    }),
  );
  await tamper(
    world,
    `update public.gate_decisions
        set payload = $3::text::jsonb, payload_digest = $4, signature = $5,
            signing_key_id = $6, hash = $7
      where business_id = $1 and id = $2`,
    [world.alpha, row.id, JSON.stringify(payload), payloadDigest, signature, key.id, hash],
  );
}

if (serverUrl === undefined) {
  console.warn('reads/decision-integrity-read: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('decision integrity on the proposal read', () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  describe('the v2 link covers the fields v1 did not', () => {
    const mutations: readonly (readonly [string, string, (w: World) => Promise<unknown[]>])[] = [
      ['round', 'round = round + 1', async () => []],
      ['decided_at', `decided_at = decided_at + interval '1 second'`, async () => []],
      ['evidence_digest', 'evidence_digest = $3', async () => ['e'.repeat(64)]],
      [
        'decided_by_actor_id',
        'decided_by_actor_id = $3',
        async (w) => {
          const others = await w.db.admin.execute<{ readonly id: string }>(
            `select a.id from public.actors a
              where a.business_id = $1
                and a.id <> (select decided_by_actor_id from public.gate_decisions
                              where business_id = $1 limit 1)
              limit 1`,
            [w.alpha],
          );
          expect(others).toHaveLength(1);
          return [others[0]?.id];
        },
      ],
    ];

    for (const [column, set, extra] of mutations) {
      it(`fails a read whose decision's ${column} was altered`, async () => {
        world = await createWorld('dint');
        const task = await decided(world);
        const params = [world.alpha, task.gateId, ...(await extra(world))];
        await tamper(
          world,
          `update public.gate_decisions set ${set} where business_id = $1 and gate_id = $2`,
          params,
        );
        await expectIntegrityFault(world, task.taskId, /seq 1: hash does not cover the row/u);
      }, 60_000);
    }

    it("fails a read whose decision's lineage_id was moved to another lineage", async () => {
      world = await createWorld('dint');
      const moved = await decided(world);
      const other = await decided(world);
      await tamper(
        world,
        `update public.gate_decisions set lineage_id = $3 where business_id = $1 and gate_id = $2`,
        [world.alpha, moved.gateId, other.lineageId],
      );
      // The lineage it left has an approved gate and nothing that approved it.
      await expectIntegrityFault(world, moved.taskId, /is approved and has no decision/u);
      // The lineage it arrived in reads it, and the v2 link covers the column.
      await expectIntegrityFault(world, other.taskId, /seq 1: hash does not cover the row/u);
    }, 60_000);

    it('reports a decision written now as link v2', async () => {
      world = await createWorld('dint');
      const task = await decided(world);
      const answer = await readTask(world, task.taskId);
      expect(answer.status).toBe(200);
      expect(decisionsOf(answer)[0]?.['linkVersion']).toBe(2);
      expect((await onlyRow(world)).payload['link']).toBe(2);
    }, 60_000);

    it('verifies a stored v1 row as v1, reports it as v1, and does not rewrite it', async () => {
      world = await createWorld('dint');
      const task = await decided(world);
      await restoreAs(world, 1, configuredKey());
      const before = await storedDecisions(world);

      const answer = await readTask(world, task.taskId);
      expect(answer.status).toBe(200);
      expect(decisionsOf(answer)[0]?.['linkVersion']).toBe(1);
      expect(await storedDecisions(world)).toStrictEqual(before);

      // Honest about what v1 is: its link never covered the round, so an
      // altered round on a v1 row still verifies. That is why it is labelled.
      await tamper(
        world,
        'update public.gate_decisions set round = round + 1 where business_id = $1',
        [world.alpha],
      );
      expect((await readTask(world, task.taskId)).status).toBe(200);
    }, 60_000);

    it('fails a v2 row relabelled as v1: the label is inside the signed payload', async () => {
      world = await createWorld('dint');
      const task = await decided(world);
      await tamper(
        world,
        `update public.gate_decisions set payload = payload - 'link' where business_id = $1`,
        [world.alpha],
      );
      await expectIntegrityFault(world, task.taskId, /seq 1: payload does not match/u);
    }, 60_000);
  });

  describe('the key resolver', () => {
    it('verifies a row signed under a retained older key id, and fails an unknown one', async () => {
      world = await createWorld('dint');
      const task = await decided(world);
      const retired: SigningKey = { id: 'test/retired@0', secret: randomUUID() };
      await restoreAs(world, 2, retired);

      const retained = await readDirect(
        world,
        task.taskId,
        keyResolver([configuredKey(), retired]),
      );
      expect(retained[0]?.decisions).toHaveLength(1);
      expect(retained[0]?.decisions[0]?.signingKeyId).toBe(retired.id);

      const unknown = await rejectionOf(
        readDirect(world, task.taskId, keyResolver([configuredKey()])),
      );
      expect(unknown).toBeInstanceOf(DecisionIntegrityError);
      expect((unknown as Error).message).toMatch(/seq 1: unknown signing key test\/retired@0/u);

      // The deployment's resolver holds the configured key only, so over HTTP
      // the same row is the named fault.
      await expectIntegrityFault(world, task.taskId, /unknown signing key/u);
    }, 60_000);
  });

  describe('the named fault', () => {
    it('answers DECISION_INTEGRITY with no stored value, rows unchanged, no audit row', async () => {
      world = await createWorld('dint');
      const task = await decided(world);
      await tamper(
        world,
        `update public.gate_decisions
            set payload = jsonb_set(payload, '{note}', '"approved for something else"')
          where business_id = $1 and gate_id = $2`,
        [world.alpha, task.gateId],
      );
      const stored = await storedDecisions(world);
      const auditsBefore = await readAudits(world);

      const answer = await readTask(world, task.taskId);
      expect(answer.status).toBe(500);
      expect(answer.body).toStrictEqual({
        code: 'DECISION_INTEGRITY',
        names: [],
        fixes: [
          'The stored decisions on this task did not verify, so none of it was shown.',
          'Nothing was changed. Retrying will give the same answer; report it to the operator.',
        ],
      });
      const text = JSON.stringify(answer.body);
      const row = stored[0] as Record<string, unknown>;
      for (const value of [
        task.taskId,
        task.gateId,
        row['id'],
        row['hash'],
        row['signature'],
        row['signing_key_id'],
        'seq',
      ]) {
        expect(text).not.toContain(String(value));
      }

      expect(await storedDecisions(world)).toStrictEqual(stored);
      // The read's transaction ends with the fault, and its audit row with it.
      expect(await readAudits(world)).toBe(auditsBefore);
    }, 60_000);
  });

  describe('U1: what the chain cannot see', () => {
    it('fails a read whose gate is approved with no decision row', async () => {
      world = await createWorld('dint');
      const task = await decided(world);
      await tamper(world, 'delete from public.gate_decisions where business_id = $1', [
        world.alpha,
      ]);
      await expectIntegrityFault(world, task.taskId, /is approved and has no decision/u);
    }, 60_000);

    it('fails a rejected lineage whose rejection was removed and its gate reset', async () => {
      world = await createWorld('dint');
      const task = await decided(world, 'reject');
      await tamper(world, 'delete from public.gate_decisions where business_id = $1', [
        world.alpha,
      ]);
      await world.db.admin.execute(
        `update public.gates set state = 'pending', decided_at = null
          where business_id = $1 and id = $2`,
        [world.alpha, task.gateId],
      );
      await expectIntegrityFault(
        world,
        task.taskId,
        /was rejected at a gate and has no rejection/u,
      );
    }, 60_000);

    it('fails a lineage whose newest requested changes were removed behind a later round', async () => {
      world = await createWorld('dint');
      const first = await decided(world, 'request_changes');
      const successor = await propose(world, first.taskId, first.lineageId);
      expect(successor['lineageId']).toBe(first.lineageId);
      await tamper(world, 'delete from public.gate_decisions where business_id = $1', [
        world.alpha,
      ]);
      await world.db.admin.execute(
        `update public.gates set state = 'superseded' where business_id = $1 and id = $2`,
        [world.alpha, first.gateId],
      );
      await expectIntegrityFault(world, first.taskId, /round 2 gate and 0 requested changes/u);
    }, 60_000);
  });
});
