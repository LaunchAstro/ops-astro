// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 personal information stays local, S3: a field's business-internal
// source is the broker's finding from the row it is bound to, never the
// caller's claim (owner line 72). A bound field reads only the run's own
// task, and only a field the agent is shown; the task is business-internal
// only when a person of the business entered it and no agent wrote to it.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  reserveModelCall,
  sendReservedCall,
  type ModelCallField,
} from '../../packages/core-custody/src/index.ts';
import {
  asPerson,
  awaitParked,
  codeOf,
  createTask,
  liveWork,
  racer,
  revisionOf,
  seedSchedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  noDatabase,
  useBrokerWorld,
  PLANTED_PROMPT,
  CLOUD,
  LOCAL,
  s,
  world,
  withRoutes,
  stepOf,
  requestFor,
  caller,
  call,
  rowsOf,
} from './broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('s3source');

const bound = (recordId: string, key = 'title'): ModelCallField => ({
  name: 'tone',
  from: { recordId, key },
});

const setData = async (recordId: string, patch: Readonly<Record<string, string>>) =>
  await s.db.admin.execute(
    `update public.records set data = data || $2::text::jsonb where id = $1`,
    [recordId, JSON.stringify(patch)],
  );

/** An applied operation by the agent on the task, as the register records one. */
const AGENT_WROTE = `insert into public.operations
    (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result, record_id, revision)
  values ($1, $2, $3, 'task.update', $4, $5, 'applied', '{}'::jsonb, $6, 2)`;
const agentWrote = (taskId: string): readonly unknown[] => [
  s.business,
  randomUUID(),
  `s3-${randomUUID()}`,
  s.agentActorId,
  '0'.repeat(64),
  taskId,
];

it('AW-01 personal information stays local (S3): a caller that only claims business_internal goes local', async () => {
  const work = await liveWork(s, 's3 a claim alone', 2_000);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  const claimed: ModelCallField = {
    name: 'tone',
    source: 'business_internal',
    value: PLANTED_PROMPT,
  };
  expect(await call(work, { fields: [claimed] }, withRoutes([CLOUD]))).toMatchObject({
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
  });
  expect(world.provider.seen.length).toBe(seen);
  const local = await call(work, { fields: [claimed] }, withRoutes([CLOUD, LOCAL]));
  expect(local.ok).toBe(true);
  expect(await rowsOf((local as { callId: string }).callId)).toMatchObject([
    { route_key: 'on_premises', route_reach: 'local' },
  ]);
}, 120_000);

it("AW-01 personal information stays local (S3): the run's own task, entered by a person, reaches the cloud with its own value", async () => {
  const value = `s3-internal-${randomUUID()}`;
  const work = await liveWork(s, value, 2_000);
  world.provider.mode('answer');
  const answer = await call(work, { fields: [bound(work.taskId)] }, withRoutes([CLOUD]));
  expect(answer.ok).toBe(true);
  expect(await rowsOf((answer as { callId: string }).callId)).toMatchObject([
    { route_key: 'replay', route_reach: 'cloud' },
  ]);
  // The value is the row's, read by the broker: the caller sent none.
  expect(world.provider.seen.at(-1)?.body).toContain(value);
}, 120_000);

it('AW-01 personal information stays local (S3): a task entered by an agent, an import, an outside party or an integration goes local', async () => {
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  for (const entered of ['agent:api', 'person:import', 'external_party:app', 'integration:api']) {
    /* eslint-disable no-await-in-loop -- one work per provenance */
    const work = await liveWork(s, `s3 entered as ${entered}`, 2_000);
    await setData(work.taskId, { source: entered });
    const answer = await call(work, { fields: [bound(work.taskId)] }, withRoutes([CLOUD]));
    /* eslint-enable no-await-in-loop */
    expect(answer, entered).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
  }
  expect(world.provider.seen.length).toBe(seen);
}, 120_000);

it("AW-01 personal information stays local (S3): a person's task an agent then wrote to goes local", async () => {
  const work = await liveWork(s, 's3 an agent wrote', 2_000);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  await s.db.admin.execute(AGENT_WROTE, agentWrote(work.taskId));
  expect(await call(work, { fields: [bound(work.taskId)] }, withRoutes([CLOUD]))).toMatchObject({
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
  });
  expect(world.provider.seen.length).toBe(seen);
}, 120_000);

/** Every source the agent may not read, each refused in the same bytes. */
async function unreadable(work: Work): Promise<readonly [string, ModelCallField][]> {
  const other = await seedSchedules(s.db, `s3other${randomUUID().slice(0, 8)}`, 1_000_000);
  const commented = await createTask(s, `s3-commented-${randomUUID()}`);
  const comment = await asPerson(s, {
    command: 'task.comment',
    operationId: randomUUID(),
    recordId: commented,
    expectedRevision: await revisionOf(s, commented),
    body: `s3-comment-${randomUUID()}`,
    audience: 'internal',
  });
  expect(codeOf(comment)).toBe('applied');
  const [commentRow] = await s.db.admin.execute<{ id: string }>(
    `select id::text as id from public.records where business_id = $1 and data->>'body' like 's3-comment-%'
      order by created_at desc limit 1`,
    [s.business],
  );
  await setData(work.taskId, { description: `s3-not-shown-${randomUUID()}` });
  return [
    ['a task of this business it does not work', bound(await createTask(s, 's3 another task'))],
    ["another business's task", bound(await createTask(other, 's3 foreign'))],
    ['a comment', bound(String(commentRow?.id), 'body')],
    ['a made-up id', bound(randomUUID())],
    ['a malformed id', bound('not-a-uuid')],
    ['a field it is not shown', bound(work.taskId, 'description')],
    ['a key the task lacks', bound(work.taskId, 'no_such_key')],
  ];
}

it('AW-01 personal information stays local (S3): a source the agent may not read is refused alike, and nothing is sent', async () => {
  const work = await liveWork(s, 's3 unreadable', 2_000);
  world.provider.mode('answer');
  const cases = await unreadable(work);
  const seen = world.provider.seen.length;
  const shapes = new Set<string>();
  for (const [label, field] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await call(work, { fields: [field] }, withRoutes([CLOUD, LOCAL]));
    expect(answer, label).toMatchObject({ ok: false, code: 'SOURCE_UNREADABLE' });
    const { callId: _callId, ...shape } = answer as { callId: string };
    shapes.add(JSON.stringify(shape));
  }
  // Same bytes whoever's row it was: no id, title or count of it.
  expect(shapes.size).toBe(1);
  expect(world.provider.seen.length).toBe(seen);
}, 120_000);

it('AW-01 personal information stays local (S3): a trashed task is not a source', async () => {
  const work = await liveWork(s, 's3 trashed', 2_000);
  await s.db.admin.execute(
    `update public.records set deleted_at = now(), deleted_by_actor_id = $2, trash_batch_id = $3
      where id = $1`,
    [work.taskId, s.decider.actorId, randomUUID()],
  );
  expect(
    await call(work, { fields: [bound(work.taskId)] }, withRoutes([CLOUD, LOCAL])),
  ).toMatchObject({ ok: false, code: 'SOURCE_UNREADABLE' });
}, 120_000);

it('AW-01 personal information stays local (S3) race: an agent write between the hold and the start releases the call unsent', async () => {
  const work = await liveWork(s, 's3 hold then write', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  const request = requestFor(work, { fields: [bound(work.taskId)] });
  const cloud = withRoutes([CLOUD]);
  const reserving = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), request, cloud),
  );
  if (!reserving.ok) throw new Error(`the hold was refused ${reserving.code}`);
  expect(reserving.reserved.route.reach).toBe('cloud');
  const seen = world.provider.seen.length;
  await s.db.admin.execute(AGENT_WROTE, agentWrote(work.taskId));
  const sent = await sendReservedCall(
    s.db.app,
    s.business,
    caller(work),
    request,
    reserving.reserved,
    cloud,
  );
  expect(sent).toEqual({
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
    callId: reserving.reserved.callId,
  });
  expect(world.provider.seen.length).toBe(seen);
  expect(await rowsOf(reserving.reserved.callId)).toMatchObject([
    { state: 'released', started_at: null },
  ]);
}, 120_000);

it("AW-01 personal information stays local (S3) race: a call waits on an agent's edit in flight on its task, then goes local", async () => {
  const work = await liveWork(s, 's3 an edit in flight', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  const editor = racer(s);
  let commit!: () => void;
  const gate = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let written!: () => void;
  const ready = new Promise<void>((resolve) => {
    written = resolve;
  });
  // The edit and its register row, held uncommitted as a command in flight holds them.
  const editing = editor.withBusiness(s.business, async (tx) => {
    await tx.query(
      `update public.records set data = data || '{"title":"s3 edited"}'::jsonb
        where business_id = $1 and id = $2`,
      [s.business, work.taskId],
    );
    await tx.query(AGENT_WROTE, agentWrote(work.taskId));
    written();
    await gate;
  });
  try {
    await ready;
    const answering = call(work, { fields: [bound(work.taskId)] }, withRoutes([CLOUD]));
    // Parked on the task row: nothing is decided until the edit commits.
    await awaitParked(s, 'records', 1);
    commit();
    await editing;
    expect(await answering).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(world.provider.seen.length).toBe(seen);
  } finally {
    commit();
    await editing.catch(() => {});
    await editor.close();
  }
}, 120_000);
