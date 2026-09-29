// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 personal information stays local, S3: a field's business-internal
// source is the broker's finding from the row it is bound to, never the
// caller's claim (owner line 72). A caller's claim alone, a client's row, a
// row entered by anyone but the business's own people or written to by an
// agent, and a foreign, made-up or trashed row never reach a cloud route.

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

/** A staff person's own task through the API, its title the planted value. */
const internalRow = async (title: string = `s3-${randomUUID()}`): Promise<string> =>
  await createTask(s, title);

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

it('AW-01 personal information stays local (S3): a field bound to a staff-entered task with no client reaches the cloud, with the row value', async () => {
  const work = await liveWork(s, 's3 a bound internal row', 2_000);
  world.provider.mode('answer');
  const value = `s3-internal-${randomUUID()}`;
  const row = await internalRow(value);
  const answer = await call(work, { fields: [bound(row)] }, withRoutes([CLOUD]));
  expect(answer.ok).toBe(true);
  expect(await rowsOf((answer as { callId: string }).callId)).toMatchObject([
    { route_key: 'replay', route_reach: 'cloud' },
  ]);
  // The value is the row's, read by the broker: the caller sent none.
  expect(world.provider.seen.at(-1)?.body).toContain(value);
}, 120_000);

it('AW-01 personal information stays local (S3): a bound row a client is on goes local', async () => {
  const work = await liveWork(s, 's3 a client row', 2_000);
  world.provider.mode('answer');
  const row = await internalRow();
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [row, randomUUID()],
  );
  const seen = world.provider.seen.length;
  expect(await call(work, { fields: [bound(row)] }, withRoutes([CLOUD]))).toMatchObject({
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
  });
  expect(world.provider.seen.length).toBe(seen);
  const local = await call(work, { fields: [bound(row)] }, withRoutes([CLOUD, LOCAL]));
  expect(await rowsOf((local as { callId: string }).callId)).toMatchObject([
    { route_reach: 'local' },
  ]);
}, 120_000);

it('AW-01 personal information stays local (S3): rows entered by an agent, an import, an outside party or an integration go local', async () => {
  const work = await liveWork(s, 's3 entered elsewhere', 2_000);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  for (const entered of ['agent:api', 'person:import', 'external_party:app', 'integration:api']) {
    // eslint-disable-next-line no-await-in-loop
    const row = await internalRow();
    // eslint-disable-next-line no-await-in-loop
    await s.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('source', $2::text) where id = $1`,
      [row, entered],
    );
    // eslint-disable-next-line no-await-in-loop
    expect(await call(work, { fields: [bound(row)] }, withRoutes([CLOUD])), entered).toMatchObject({
      ok: false,
      code: 'LOCAL_MODEL_REQUIRED',
    });
  }
  expect(world.provider.seen.length).toBe(seen);
}, 120_000);

it("AW-01 personal information stays local (S3): a comment, a row of another type, goes local even with a person's source", async () => {
  const work = await liveWork(s, 's3 a comment', 2_000);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  const commented = await internalRow();
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
    `select r.id::text as id from public.records r
       join public.record_types ty on ty.id = r.record_type_id
      where r.business_id = $1 and ty.key <> 'task' and r.data->>'body' like 's3-comment-%'
      order by r.created_at desc limit 1`,
    [s.business],
  );
  if (commentRow === undefined) throw new Error('no comment row');
  // Even stamped with a person's source, so only its type keeps it local.
  await s.db.admin.execute(
    `update public.records set data = data || '{"source":"person:api"}'::jsonb where id = $1`,
    [commentRow.id],
  );
  expect(
    await call(work, { fields: [bound(commentRow.id, 'body')] }, withRoutes([CLOUD])),
  ).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
  expect(world.provider.seen.length).toBe(seen);
}, 120_000);

it("AW-01 personal information stays local (S3): a person's row an agent then wrote to goes local", async () => {
  const work = await liveWork(s, 's3 an agent wrote', 2_000);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  // The register names the agent on the row.
  const edited = await internalRow();
  await s.db.admin.execute(
    `insert into public.operations
       (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result, record_id, revision)
     values ($1, $2, $3, 'task.update', $4, $5, 'applied', '{}'::jsonb, $6, 2)`,
    [s.business, randomUUID(), `s3-${randomUUID()}`, s.agentActorId, '0'.repeat(64), edited],
  );
  expect(await call(work, { fields: [bound(edited)] }, withRoutes([CLOUD]))).toMatchObject({
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
  });
  expect(world.provider.seen.length).toBe(seen);
}, 120_000);

it('AW-01 personal information stays local (S3): a foreign, made-up, trashed or unreadable source is refused alike, and nothing is sent', async () => {
  const work = await liveWork(s, 's3 unreadable', 2_000);
  world.provider.mode('answer');
  const other = await seedSchedules(s.db, `s3other${randomUUID().slice(0, 8)}`, 1_000_000);
  const foreign = await createTask(other, `s3-foreign-${randomUUID()}`);
  const trashed = await internalRow();
  const trashing = await asPerson(s, {
    command: 'task.trash',
    operationId: randomUUID(),
    recordId: trashed,
    expectedRevision: await revisionOf(s, trashed),
  });
  expect(codeOf(trashing)).toBe('applied');
  const live = await internalRow();
  const seen = world.provider.seen.length;
  const cases: readonly ModelCallField[] = [
    bound(foreign),
    bound(randomUUID()),
    bound('not-a-uuid'),
    bound(trashed),
    // A key the row does not hold as a string.
    bound(live, 'no_such_key'),
  ];
  const answers = [];
  for (const field of cases) {
    // eslint-disable-next-line no-await-in-loop
    answers.push(await call(work, { fields: [field] }, withRoutes([CLOUD, LOCAL])));
  }
  for (const answer of answers) {
    expect(answer).toMatchObject({ ok: false, code: 'SOURCE_UNREADABLE' });
    // Same bytes whoever's row it was: no id, title or count of it.
    const { callId: _callId, ...shape } = answer as { callId: string };
    expect(JSON.stringify(shape)).toBe(
      JSON.stringify((({ callId: _c, ...rest }) => rest)(answers[1] as { callId: string })),
    );
    expect(JSON.stringify(answer)).not.toContain(foreign);
  }
  expect(world.provider.seen.length).toBe(seen);
}, 120_000);

it('AW-01 personal information stays local (S3) race: a client put on the source row between the hold and the start releases the call unsent', async () => {
  const work = await liveWork(s, 's3 hold then link', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  const row = await internalRow();
  const request = requestFor(work, { fields: [bound(row)] });
  const cloud = withRoutes([CLOUD]);
  const reserving = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), request, cloud),
  );
  if (!reserving.ok) throw new Error(`the hold was refused ${reserving.code}`);
  expect(reserving.reserved.route.reach).toBe('cloud');
  const seen = world.provider.seen.length;
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [row, randomUUID()],
  );
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

it('AW-01 personal information stays local (S3) race: a call waits on a client link in flight on its source row, then goes local', async () => {
  const work = await liveWork(s, 's3 a link in flight', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  const row = await internalRow();
  const seen = world.provider.seen.length;
  const linker = racer(s);
  let commit!: () => void;
  const gate = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let written!: () => void;
  const ready = new Promise<void>((resolve) => {
    written = resolve;
  });
  const linking = linker.withBusiness(s.business, async (tx) => {
    await tx.query(
      `update public.records set data = data || jsonb_build_object('client', $3::text)
        where business_id = $1 and id = $2`,
      [s.business, row, randomUUID()],
    );
    written();
    await gate;
  });
  try {
    await ready;
    const answering = call(work, { fields: [bound(row)] }, withRoutes([CLOUD]));
    // Parked on the source row: nothing is decided until the link commits.
    await awaitParked(s, 'records', 1);
    commit();
    await linking;
    expect(await answering).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(world.provider.seen.length).toBe(seen);
  } finally {
    commit();
    await linking.catch(() => {});
    await linker.close();
  }
}, 120_000);
