// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 attribution pre-review`: attribution across runs is a projection by
// digest, entry and non-entry reads alike, labelled pre-review: the runs whose
// ledger read the file and the operations those runs reached (a refused call
// reached nothing). It is the team's read (`definition.attribution`), each run
// filtered by the caller's task read grant inside the query. Its isolation
// case crosses another business, another client and another person's agent.
// That nothing outside the read takes it is the deps cruise rule
// `pre-review-attribution-stays-in-its-read` (tests/ci/deps-cruise-cases.mjs).

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { identityOf } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { liveWork, type Schedules, type Work } from './schedules-harness.ts';
import { cq8World } from './t2d-harness.ts';
import {
  ENTRY,
  FILES,
  FRAGMENT,
  anotherPersonsAgent,
  leaseOf,
  noDatabase,
  seedPin,
  seedRead,
  useAw02World,
  w,
} from './aw-02-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw02World('aw04attr');

const digestOf = (path: string): string =>
  identityOf(path, FILES.get(path) ?? new Uint8Array()).digest;
const ENTRY_DIGEST = digestOf(ENTRY);
const FRAGMENT_DIGEST = digestOf(FRAGMENT);

/** A model call on the work's run, as the broker records one; `refused` reached nothing. */
async function called(owner: Schedules, work: Work, operation: string, refused = false) {
  await owner.db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
        state, reserved_minor, refusal_code, ended_at)
     select l.business_id, $2, l.run_id,
            (select s.id from public.planned_steps s
              where s.business_id = l.business_id and s.run_id = l.run_id limit 1),
            l.id, r.version_id, r.id, $3,
            case when $4 then 'refused' else 'reserved' end, case when $4 then 0 else 500 end,
            case when $4 then 'CAP_EXCEEDED' end, case when $4 then clock_timestamp() end
       from public.leases l join public.reservations r
         on r.business_id = l.business_id and r.id = l.reservation_id
      where l.id = $1`,
    [work.picked['leaseId'], randomUUID(), operation, refused],
  );
}

async function readNonEntry(owner: Schedules, runId: string): Promise<void> {
  const fragment = identityOf(FRAGMENT, FILES.get(FRAGMENT) ?? new Uint8Array());
  await owner.db.admin.execute(
    `insert into public.bootstrap_reads
       (business_id, id, run_id, sequence, path, content_digest, content_size, is_entry)
     values ($1, $2, $3, 2, $4, $5, $6, false)`,
    [owner.business, randomUUID(), runId, fragment.path, fragment.digest, fragment.size],
  );
}

const world = {} as { second: Work; runA: string; runB: string; runBravo: string };

beforeAll(async () => {
  if (noDatabase) return;
  world.runA = (await leaseOf(w.alpha, w.alphaWork.picked['leaseId'])).run_id;
  world.runBravo = (await leaseOf(w.bravo, w.bravoWork.picked['leaseId'])).run_id;
  world.second = await liveWork(w.alpha, 'aw04attr second run', 1_000);
  world.runB = (await leaseOf(w.alpha, world.second.picked['leaseId'])).run_id;
  await seedPin(w.alpha, world.runB);
  await seedRead(w.alpha, world.runB);
  await readNonEntry(w.alpha, world.runA);
  await called(w.alpha, w.alphaWork, 'model.compose');
  await called(w.alpha, w.alphaWork, 'model.never_reached', true);
  await called(w.alpha, world.second, 'model.review');
  await called(w.bravo, w.bravoWork, 'model.bravo_only');
}, 180_000);

async function attribution(
  owner: Schedules,
  digest: unknown,
  who: Member = owner.decider,
): Promise<Record<string, unknown>> {
  return (await executeRead(owner.db.app, owner.business, who.presented, {
    read: 'definition.attribution',
    digest,
  } as never)) as Record<string, unknown>;
}

/** One run's pre-review row, as the entry read and one reached operation make it. */
const runOf = (taskId: string, runId: string, operation: string) => ({
  label: 'pre-review',
  taskId,
  runId,
  paths: [ENTRY],
  entry: true,
  operations: [operation],
});

it('AW-04 attribution pre-review: a digest names the runs that read it, entry and non-entry, and the operations they reached, labelled pre-review', async () => {
  const both = [
    runOf(w.alphaWork.taskId, world.runA, 'model.compose'),
    runOf(world.second.taskId, world.runB, 'model.review'),
  ].toSorted((a, b) => a.runId.localeCompare(b.runId));
  expect(await attribution(w.alpha, ENTRY_DIGEST)).toStrictEqual({
    ok: true,
    attribution: {
      label: 'pre-review',
      digest: ENTRY_DIGEST,
      runs: both,
      operations: ['model.compose', 'model.review'],
    },
  });
  expect(await attribution(w.alpha, FRAGMENT_DIGEST)).toMatchObject({
    attribution: {
      runs: [{ label: 'pre-review', runId: world.runA, paths: [FRAGMENT], entry: false }],
      operations: ['model.compose'],
    },
  });
  expect(await attribution(w.alpha, 'a'.repeat(64))).toStrictEqual({
    ok: true,
    attribution: { label: 'pre-review', digest: 'a'.repeat(64), runs: [], operations: [] },
  });
}, 60_000);

it('AW-04 attribution pre-review: the digest is 64 lowercase hex, and anything else is refused naming it', async () => {
  for (const digest of [
    ENTRY_DIGEST.toUpperCase(),
    ENTRY_DIGEST.slice(1),
    `${ENTRY_DIGEST}0`,
    ` ${ENTRY_DIGEST}`,
    `${ENTRY_DIGEST.slice(1)}\t`,
    `${ENTRY_DIGEST.slice(0, 63)}g`,
    7,
    null,
    undefined,
    [ENTRY_DIGEST],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await attribution(w.alpha, digest);
    expect(answer, JSON.stringify(digest)).toMatchObject({
      code: 'FIELD_VALUE_INVALID',
      names: ['digest'],
    });
    expect(JSON.stringify(answer)).not.toContain(world.runA);
  }
}, 60_000);

/** No id or word of the other side in a crossed body. */
function absent(body: unknown, ids: readonly string[], words: readonly string[] = []): void {
  const text = JSON.stringify(body);
  for (const id of [...ids, ...words]) expect(text).not.toContain(id);
}

const alphaIds = (): readonly string[] => [
  world.runA,
  world.runB,
  w.alphaWork.taskId,
  world.second.taskId,
];
const bravoIds = (): readonly string[] => [world.runBravo, w.bravoWork.taskId];

/** Another business: the same digest answers each business its own runs. */
async function anotherBusiness(): Promise<void> {
  const bravoSees = await attribution(w.bravo, ENTRY_DIGEST);
  expect(bravoSees).toMatchObject({
    attribution: { runs: [{ runId: world.runBravo }], operations: ['model.bravo_only'] },
  });
  absent(bravoSees, alphaIds(), ['model.compose', 'model.review']);
  absent(await attribution(w.alpha, ENTRY_DIGEST), bravoIds(), ['model.bravo_only']);
  expect(await attribution(w.bravo, FRAGMENT_DIGEST)).toMatchObject({
    attribution: { runs: [], operations: [] },
  });
}

/**
 * Another client, shared task A: attribution is the team's, so it is refused.
 * A member granted read on task B alone sees task B's run alone.
 */
async function anotherClient(): Promise<void> {
  await w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
    await grantTo(tx, w.alpha.decider, 'share');
  });
  const client = await cq8World(w.alpha).client(
    w.alpha.business,
    w.alpha.decider,
    'aw04attr-client',
    w.alphaWork.taskId,
  );
  const clientSees = await attribution(w.alpha, ENTRY_DIGEST, client);
  expect(clientSees).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  absent(clientSees, [...alphaIds(), ...bravoIds()], ['model.']);
  const member = await enrol(w.alpha.db.app, w.alpha.business, 'aw04attr-member');
  await w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
    await grantTo(tx, member, 'read', { kind: 'record', id: world.second.taskId });
  });
  const memberSees = await attribution(w.alpha, ENTRY_DIGEST, member);
  expect(memberSees).toMatchObject({
    attribution: { runs: [{ runId: world.runB }], operations: ['model.review'] },
  });
  absent(memberSees, [world.runA, w.alphaWork.taskId, ...bravoIds()], ['model.compose']);
  const idle = await enrol(w.alpha.db.app, w.alpha.business, 'aw04attr-idle');
  const idleSees = await attribution(w.alpha, ENTRY_DIGEST, idle);
  expect(idleSees).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  absent(idleSees, alphaIds(), ['model.']);
}

it('AW-04 attribution pre-review isolation: another business, another client, another person under a live delegation', async () => {
  await anotherBusiness();
  await anotherClient();

  // Another person's agent under its own live delegation: no agent route.
  const other = await anotherPersonsAgent(w.alpha);
  const agentSees = await executeAgentCommand(
    w.alpha.db.app,
    w.alpha.business,
    { provider: 'supabase', subject: other.subject },
    undefined,
    { command: 'definition.attribution', operationId: randomUUID(), digest: ENTRY_DIGEST } as never,
  );
  expect(agentSees).toMatchObject({ code: 'DELEGATION_EXCLUDES_OPERATION' });
  absent(agentSees, [...alphaIds(), other.run_id], ['model.']);

  // A trashed task's runs are not listed.
  await w.alpha.db.admin.execute(
    `update public.records set deleted_at = now(), trash_batch_id = $2, deleted_by_actor_id = $3
      where id = $1`,
    [world.second.taskId, randomUUID(), w.alpha.decider.actorId],
  );
  const afterTrash = await attribution(w.alpha, ENTRY_DIGEST);
  expect(afterTrash).toMatchObject({
    attribution: { runs: [{ runId: world.runA }], operations: ['model.compose'] },
  });
  absent(afterTrash, [world.runB, world.second.taskId], ['model.review']);
}, 180_000);
