// SPDX-License-Identifier: AGPL-3.0-only
//
// A verified read shows only what the signature covers (DECISION-V3).
//
// The link hash is unkeyed, so a writer who changes a row and recomputes that
// row's hash and every later link leaves a chain that holds. Only the signed
// payload stops them, and only for what the payload names and the read binds.
// Each case here tampers and then **recomputes the chain**, so a fault comes
// from the signature or the column-to-payload binding, never from a stale hash:
//
// - **(i) a fabricated signer**: `decided_by_person_id` rewritten;
// - **(ii) a transplant**: one approval's payload, digest, signature and key
//   id copied onto a new head row for another, undecided gate, which is then
//   marked approved. This needs only INSERT on `gate_decisions` and UPDATE on
//   `gates`, which the application role holds;
// - **(iii) link-only metadata**: round, decision time and acting actor.
//
// (i) and (ii) fail on every payload format. (iii), and a change to every
// other field and link the v3 payload names, fails on v3. On v1 and v2 rows
// (iii) still verifies, because neither signed those fields, and the read says
// so in `signedFields` rather than presenting them as signed.
//
// Tampering is done as the database owner with the append-only triggers off,
// as in `decision-integrity-read.test.ts`. Each case gets its own world.

import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readTaskProposals } from '../../packages/core-records/src/reads/proposals.ts';
import { DecisionIntegrityError } from '../../packages/core-records/src/reads/verified-decisions.ts';
import {
  CHAIN_GENESIS,
  canonicalise,
  chainHash,
  decisionLink,
  decisionPayload,
  digestOf,
  LINK_VERSION,
  linkVersionOf,
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

interface Task {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
  readonly lineageId: string;
}

const asAda = async (world: World, name: string, body: Readonly<Record<string, unknown>>) =>
  await call(world.api, personPath('alpha', name), body, bearer(world.ada.token));

async function revisionOf(world: World, recordId: string): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [world.alpha, recordId],
  );
  return Number(rows[0]?.revision ?? '0');
}

/** A task with one proposal on it, undecided. */
async function proposed(world: World): Promise<Task> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a decision worth checking ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  const taskId = String(created.body['recordId']);
  const answer = await asAda(world, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
    purpose: 'draft_the_reply',
    maximumMinor: 1500,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  });
  expect(answer.code, 'propose').toBe('ok');
  const detail = answer.body['detail'] as Record<string, string>;
  return {
    taskId,
    gateId: String(detail['gateId']),
    versionId: String(detail['versionId']),
    lineageId: String(detail['lineageId']),
  };
}

/** A task, a proposal on it and its approval, through the production path. */
async function approved(world: World): Promise<Task> {
  const task = await proposed(world);
  const answer = await asAda(world, '/task/decide', {
    operationId: randomUUID(),
    gateId: task.gateId,
    versionId: task.versionId,
    decision: 'approve',
    note: 'approve as proposed',
  });
  expect(answer.code, 'decide').toBe('ok');
  return task;
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

/** Statements as the owner, with the append-only triggers off for them alone. */
async function asOwner(world: World, work: () => Promise<void>): Promise<void> {
  await world.db.admin.execute('alter table public.gate_decisions disable trigger all');
  try {
    await work();
  } finally {
    await world.db.admin.execute('alter table public.gate_decisions enable trigger all');
  }
}

async function tamper(world: World, sql: string, params: readonly unknown[]): Promise<void> {
  await asOwner(world, async () => {
    await world.db.admin.execute(sql, params as unknown[]);
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (cause) {
    return cause;
  }
}

async function readDirect(world: World, taskId: string) {
  return await world.db.app.withBusiness(world.alpha, async (tx) => readTaskProposals(tx, taskId));
}

/** The HTTP answer is the named fault, and the direct read names where it broke. */
async function expectIntegrityFault(world: World, taskId: string, where: RegExp) {
  const answer = await readTask(world, taskId);
  expect(answer.status, 'a fault, under 500').toBe(500);
  expect(answer.body['code']).toBe('DECISION_INTEGRITY');
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
  readonly signing_key_id: string;
  readonly signature: string;
  readonly prev_hash: string;
  readonly hash: string;
}

async function storedRows(world: World): Promise<readonly StoredRow[]> {
  return await world.db.admin.execute<StoredRow>(
    `select id, seq::text as seq, gate_id, version_id, lineage_id, decision, round,
            decided_by_person_id, decided_by_actor_id, evidence_digest, payload,
            payload_digest, signing_key_id, signature, prev_hash, hash,
            to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as decided_at
       from public.gate_decisions where business_id = $1 order by seq`,
    [world.alpha],
  );
}

/**
 * What an owner-access writer does after changing a row: recompute every
 * unkeyed link from the columns, at each row's own link version, so the chain
 * holds again. Nothing keyed is touched.
 */
async function recomputeChain(world: World): Promise<void> {
  const rows = await storedRows(world);
  const links: { readonly id: string; readonly prev: string; readonly hash: string }[] = [];
  let previous = CHAIN_GENESIS;
  for (const row of rows) {
    const hash = chainHash(
      previous,
      decisionLink(linkVersionOf(row.payload) ?? 1, {
        id: row.id,
        seq: Number(row.seq),
        gate: row.gate_id,
        version: row.version_id,
        decision: row.decision,
        person: row.decided_by_person_id,
        payloadDigest: row.payload_digest,
        signature: row.signature,
        round: row.round,
        decidedAt: row.decided_at,
        lineage: row.lineage_id,
        actor: row.decided_by_actor_id,
        evidence: row.evidence_digest,
        key: row.signing_key_id,
      }),
    );
    links.push({ id: row.id, prev: previous, hash });
    previous = hash;
  }
  await tamper(
    world,
    `update public.gate_decisions d set prev_hash = l.prev, hash = l.hash
       from unnest($2::uuid[], $3::text[], $4::text[]) as l(id, prev, hash)
      where d.business_id = $1 and d.id = l.id`,
    [
      world.alpha,
      links.map((link) => link.id),
      links.map((link) => link.prev),
      links.map((link) => link.hash),
    ],
  );
}

type Format = 1 | 2 | 3;

/**
 * Re-sign a decision as it was stored before v3, the way a restore of an
 * older deployment's rows holds it: v1 is the six fields `decide` signed
 * first, v2 adds `link: 2`. `3` leaves the row as `decide` writes it now.
 */
async function storeAs(world: World, format: Format, gateId: string): Promise<void> {
  if (format === 3) return;
  const row = (await storedRows(world)).find((each) => each.gate_id === gateId) as StoredRow;
  const signed = row.payload;
  const payload: Record<string, unknown> = {
    gate: signed['gate'],
    version: signed['version'],
    decision: signed['decision'],
    by: signed['by'],
    note: signed['note'],
    evidence: signed['evidence'],
    ...(format === 2 ? { link: 2 } : {}),
  };
  const payloadDigest = digestOf(payload);
  await tamper(
    world,
    `update public.gate_decisions
        set payload = $3::text::jsonb, payload_digest = $4, signature = $5
      where business_id = $1 and id = $2`,
    [
      world.alpha,
      row.id,
      JSON.stringify(payload),
      payloadDigest,
      sign(configuredKey(), payloadDigest),
    ],
  );
  await recomputeChain(world);
}

async function formatOf(world: World, gateId: string): Promise<Format> {
  const row = (await storedRows(world)).find((each) => each.gate_id === gateId) as StoredRow;
  return (linkVersionOf(row.payload) ?? 1) as Format;
}

async function anotherPerson(world: World, not: string): Promise<string> {
  const rows = await world.db.admin.execute<{ readonly id: string }>(
    `select id from public.people where business_id = $1 and id <> $2 order by id limit 1`,
    [world.alpha, not],
  );
  expect(rows).toHaveLength(1);
  return (rows[0] as { readonly id: string }).id;
}

async function anotherActor(world: World, not: string): Promise<string> {
  const rows = await world.db.admin.execute<{ readonly id: string }>(
    `select id from public.actors where business_id = $1 and id <> $2 order by id limit 1`,
    [world.alpha, not],
  );
  expect(rows).toHaveLength(1);
  return (rows[0] as { readonly id: string }).id;
}

/** (ii): the approval's signed bytes on a new head row that names `onto`. */
async function transplant(world: World, from: Task, onto: Task): Promise<void> {
  await tamper(
    world,
    `insert into public.gate_decisions
       (business_id, id, gate_id, version_id, lineage_id, seq, decision, round,
        decided_by_person_id, decided_by_actor_id, payload, payload_digest,
        evidence_digest, signing_key_id, signature, prev_hash, hash, decided_at)
     select business_id, $3, $4, $5, $6, seq + 1, decision, round,
            decided_by_person_id, decided_by_actor_id, payload, payload_digest,
            evidence_digest, signing_key_id, signature, hash, hash, decided_at
       from public.gate_decisions where business_id = $1 and gate_id = $2`,
    [world.alpha, from.gateId, randomUUID(), onto.gateId, onto.versionId, onto.lineageId],
  );
  await recomputeChain(world);
  await world.db.admin.execute(
    `update public.gates set state = 'approved', decided_at = now()
      where business_id = $1 and id = $2`,
    [world.alpha, onto.gateId],
  );
}

if (serverUrl === undefined) {
  console.warn('reads/decision-v3: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('the read binds its columns to the signed payload', () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  for (const format of [1, 2, 3] as const) {
    describe(`a v${format} decision`, () => {
      it('(i) fails a fabricated signer with the chain recomputed', async () => {
        world = await createWorld('dv3');
        const task = await approved(world);
        await storeAs(world, format, task.gateId);
        expect(await formatOf(world, task.gateId)).toBe(format);
        expect((await readTask(world, task.taskId)).status, 'untampered').toBe(200);

        const row = (await storedRows(world))[0] as StoredRow;
        await tamper(
          world,
          `update public.gate_decisions set decided_by_person_id = $3
            where business_id = $1 and id = $2`,
          [world.alpha, row.id, await anotherPerson(world, row.decided_by_person_id)],
        );
        await recomputeChain(world);
        await expectIntegrityFault(
          world,
          task.taskId,
          /seq 1: decided_by_person_id is not what the signature covers/u,
        );
      }, 60_000);

      it('(ii) fails an approval transplanted onto another undecided gate', async () => {
        world = await createWorld('dv3');
        const from = await approved(world);
        await storeAs(world, format, from.gateId);
        const onto = await proposed(world);
        await transplant(world, from, onto);
        // The approval the bytes belong to still reads.
        expect((await readTask(world, from.taskId)).status, 'the original').toBe(200);
        await expectIntegrityFault(
          world,
          onto.taskId,
          /seq 2: gate_id is not what the signature covers/u,
        );
      }, 60_000);
    });
  }

  describe('(iii) link-only metadata on the decision written now', () => {
    const mutations: readonly (readonly [string, string, (w: World) => Promise<unknown[]>])[] = [
      ['round', 'round = round + 1', async () => []],
      ['decided_at', `decided_at = decided_at + interval '1 second'`, async () => []],
      [
        'decided_by_actor_id',
        'decided_by_actor_id = $2',
        async (w) => {
          const row = (await storedRows(w))[0] as StoredRow;
          return [await anotherActor(w, row.decided_by_actor_id)];
        },
      ],
    ];

    for (const [column, set, extra] of mutations) {
      it(`fails an altered ${column} with the chain recomputed`, async () => {
        world = await createWorld('dv3');
        const task = await approved(world);
        await tamper(world, `update public.gate_decisions set ${set} where business_id = $1`, [
          world.alpha,
          ...(await extra(world)),
        ]);
        await recomputeChain(world);
        await expectIntegrityFault(
          world,
          task.taskId,
          new RegExp(`seq 1: ${column} is not what the signature covers`, 'u'),
        );
      }, 60_000);
    }
  });

  describe('v3: every other signed field and link, with the chain recomputed', () => {
    type Mutation = readonly [
      column: string,
      set: string,
      extra: (w: World, other: Task) => Promise<unknown[]>,
      readOther: boolean,
    ];
    const mutations: readonly Mutation[] = [
      ['decision', `decision = 'reject'`, async () => [], false],
      ['gate_id', 'gate_id = $2', async (_w, other) => [other.gateId], false],
      ['version_id', 'version_id = $2', async (_w, other) => [other.versionId], false],
      ['evidence_digest', 'evidence_digest = $2', async () => ['e'.repeat(64)], false],
      ['id', 'id = $2', async () => [randomUUID()], false],
      ['seq', 'seq = seq + 10', async () => [], false],
      ['lineage_id', 'lineage_id = $2', async (_w, other) => [other.lineageId], true],
    ];

    for (const [column, set, extra, readOther] of mutations) {
      it(`fails an altered ${column}`, async () => {
        world = await createWorld('dv3');
        const task = await approved(world);
        const other = await proposed(world);
        await tamper(
          world,
          `update public.gate_decisions set ${set} where business_id = $1 and gate_id = '${task.gateId}'`,
          [world.alpha, ...(await extra(world, other))],
        );
        await recomputeChain(world);
        await expectIntegrityFault(
          world,
          readOther ? other.taskId : task.taskId,
          new RegExp(`seq \\d+: ${column} is not what the signature covers`, 'u'),
        );
      }, 60_000);
    }

    it('fails a chain with an earlier decision removed: the previous link is signed', async () => {
      world = await createWorld('dv3');
      const first = await approved(world);
      const second = await approved(world);
      await tamper(
        world,
        'delete from public.gate_decisions where business_id = $1 and gate_id = $2',
        [world.alpha, first.gateId],
      );
      await recomputeChain(world);
      await expectIntegrityFault(
        world,
        second.taskId,
        /seq 2: prev_hash is not what the signature covers/u,
      );
    }, 60_000);

    it('fails a row whose key id was changed: the HMAC input names it', async () => {
      world = await createWorld('dv3');
      const task = await approved(world);
      await tamper(
        world,
        `update public.gate_decisions set signing_key_id = 'test/other@9' where business_id = $1`,
        [world.alpha],
      );
      await recomputeChain(world);
      await expectIntegrityFault(world, task.taskId, /seq 1: unknown signing key test\/other@9/u);
    }, 60_000);

    it('fails a v3 row relabelled as v2: the label is inside the signed payload', async () => {
      world = await createWorld('dv3');
      const task = await approved(world);
      await tamper(
        world,
        `update public.gate_decisions set payload = jsonb_set(payload, '{link}', '2') where business_id = $1`,
        [world.alpha],
      );
      await recomputeChain(world);
      await expectIntegrityFault(world, task.taskId, /seq 1: payload does not match/u);
    }, 60_000);
  });

  describe('what the read says each format signed', () => {
    it('reports a decision written now as v3, with every shown field signed', async () => {
      world = await createWorld('dv3');
      const task = await approved(world);
      const answer = await readTask(world, task.taskId);
      expect(answer.status).toBe(200);
      const shown = decisionsOf(answer)[0] as Record<string, unknown>;
      expect(shown['linkVersion']).toBe(3);
      expect(shown['signedFields']).toStrictEqual([
        'id',
        'seq',
        'decision',
        'round',
        'decidedByPersonId',
        'decidedAt',
        'signingKeyId',
        'prevHash',
      ]);
      const row = (await storedRows(world))[0] as StoredRow;
      expect(row.payload).toStrictEqual({
        link: 3,
        id: row.id,
        seq: 1,
        prev: CHAIN_GENESIS,
        gate: task.gateId,
        version: task.versionId,
        lineage: task.lineageId,
        round: row.round,
        decision: 'approve',
        by: row.decided_by_person_id,
        actor: row.decided_by_actor_id,
        decidedAt: row.decided_at,
        note: 'approve as proposed',
        evidence: row.evidence_digest,
        key: row.signing_key_id,
      });
    }, 60_000);

    for (const format of [1, 2] as const) {
      it(`verifies a v${format} row for what it signed, and lists no more`, async () => {
        world = await createWorld('dv3');
        const task = await approved(world);
        await storeAs(world, format, task.gateId);
        const other = (await storedRows(world))[0] as StoredRow;
        // Honest about the limit: v${format} never signed these, so with the
        // unkeyed chain recomputed they still verify. That is why the read
        // does not list them.
        await tamper(
          world,
          `update public.gate_decisions
              set round = round + 1, decided_at = decided_at + interval '1 second',
                  decided_by_actor_id = $2
            where business_id = $1`,
          [world.alpha, await anotherActor(world, other.decided_by_actor_id)],
        );
        await recomputeChain(world);
        const answer = await readTask(world, task.taskId);
        expect(answer.status).toBe(200);
        const shown = decisionsOf(answer)[0] as Record<string, unknown>;
        expect(shown['linkVersion']).toBe(format);
        expect(shown['signedFields']).toStrictEqual([
          'decision',
          'decidedByPersonId',
          'signingKeyId',
        ]);
      }, 60_000);
    }
  });
});

describe('the v3 payload is pinned', () => {
  const fields = {
    id: '00000000-0000-4000-8000-000000000001',
    seq: 7,
    prev: 'a'.repeat(64),
    gate: '00000000-0000-4000-8000-000000000002',
    version: '00000000-0000-4000-8000-000000000003',
    lineage: '00000000-0000-4000-8000-000000000004',
    round: 2,
    decision: 'approve',
    by: '00000000-0000-4000-8000-000000000005',
    actor: '00000000-0000-4000-8000-000000000006',
    decidedAt: '2026-09-23T08:00:00.123456Z',
    note: 'approve as proposed',
    evidence: 'b'.repeat(64),
    key: 'test/pinned@1',
  };
  const bytes =
    '{"actor":"00000000-0000-4000-8000-000000000006","by":"00000000-0000-4000-8000-000000000005",' +
    '"decidedAt":"2026-09-23T08:00:00.123456Z","decision":"approve","evidence":"' +
    'b'.repeat(64) +
    '","gate":"00000000-0000-4000-8000-000000000002","id":"00000000-0000-4000-8000-000000000001",' +
    '"key":"test/pinned@1","lineage":"00000000-0000-4000-8000-000000000004","link":3,' +
    '"note":"approve as proposed","prev":"' +
    'a'.repeat(64) +
    '","round":2,"seq":7,"version":"00000000-0000-4000-8000-000000000003"}';

  it('serialises to these exact bytes and digest', () => {
    expect(canonicalise(decisionPayload(fields))).toBe(bytes);
    const digest = createHash('sha256').update(bytes, 'utf8').digest('hex');
    expect(digestOf(decisionPayload(fields))).toBe(digest);
    expect(digest).toBe('8b5bf95efbb44aebb5bd526371d80dcb4f20a3befcb97385f2edbb9d98875166');
  });

  it('is the version decide writes, and v3 is a known link version', () => {
    expect(LINK_VERSION).toBe(3);
    expect(linkVersionOf(decisionPayload(fields))).toBe(3);
    expect(linkVersionOf({ link: 4 })).toBeUndefined();
    expect(decisionLink(3, { ...linkOf(fields) })['link']).toBe(3);
  });

  it('changes its digest for a change to any one field', () => {
    const base = digestOf(decisionPayload(fields));
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const value = fields[key];
      const changed = { ...fields, [key]: typeof value === 'number' ? value + 1 : `${value}x` };
      expect(digestOf(decisionPayload(changed)), key).not.toBe(base);
    }
  });
});

function linkOf(fields: {
  readonly id: string;
  readonly seq: number;
  readonly gate: string;
  readonly version: string;
  readonly decision: string;
  readonly by: string;
  readonly round: number;
  readonly decidedAt: string;
  readonly lineage: string;
  readonly actor: string;
  readonly evidence: string;
  readonly key: string;
}) {
  return {
    id: fields.id,
    seq: fields.seq,
    gate: fields.gate,
    version: fields.version,
    decision: fields.decision,
    person: fields.by,
    payloadDigest: 'c'.repeat(64),
    signature: 'd'.repeat(64),
    round: fields.round,
    decidedAt: fields.decidedAt,
    lineage: fields.lineage,
    actor: fields.actor,
    evidence: fields.evidence,
    key: fields.key,
  };
}
