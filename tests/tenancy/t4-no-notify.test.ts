// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b2 (spike RN-01): the runtime never notifies. The live channel's
// notifications come from triggers inside the transaction that wrote the row
// (`migrations/0035_live_task_channel.sql`), so the runtime's own statement
// log, over a whole journey through the application (create, propose,
// approve, pickup, dispatch, effect, observe, settle, receipt), holds no
// `NOTIFY` and no `pg_notify`. So the application role needs no notify grant,
// and none exists to hold: Postgres checks none for NOTIFY or LISTEN, and the
// default-deny conformance names no exception for them.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordedStatement } from '../../packages/core-records/src/tenancy/statements.ts';
import { pathOf, PREFIX } from '../../packages/core-wire/src/surface.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { delegate } from '../journey/passes.ts';

const NOTIFYING = /\bnotify\b|pg_notify/iu;

// eslint-disable-next-line max-lines-per-function -- one world, one journey, the check and its plant
describe.skipIf(serverUrl === undefined)('the runtime sends no NOTIFY (RN-01)', () => {
  let world: World;

  const post = async (path: string, body: object, bearer: string, held?: string) =>
    await world.api.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        ...(held === undefined ? {} : { 'x-agent-delegation': held }),
      },
      body: JSON.stringify(body),
    });
  const asAda = async (name: Parameters<typeof pathOf>[0], body: object) =>
    (await (
      await post(`${PREFIX.person}alpha${pathOf(name)}`, body, world.ada.token)
    ).json()) as Record<string, unknown>;
  const runtime = (): readonly RecordedStatement[] =>
    world.db.log.entries.filter((entry) => entry.source === 'runtime');

  beforeAll(async () => {
    world = await createWorld('t4_no_notify');
    const created = await asAda('task.create', {
      operationId: randomUUID(),
      fields: { title: 'No notify' },
    });
    const taskId = String(created['recordId']);
    const worker = createWorker({
      transport: async (path, body, bearer, held) =>
        await world.api.request(path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bearer}`,
            ...(held === undefined ? {} : { 'x-agent-delegation': held }),
          },
          body,
        }),
      businessKey: 'alpha',
      credential: world.agent.token,
      delegation: await delegate(world, taskId),
      reporter: SYNTHETIC_USAGE,
    });
    const proposed = await worker.proposeOnce();
    if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
    const read = await asAda('task.read', { recordId: taskId });
    const task = read['task'] as { proposals: { versions: { versionId: string }[] }[] };
    await asAda('task.decide', {
      operationId: randomUUID(),
      gateId: proposed.proposed.gateId,
      versionId: task.proposals[0]?.versions[0]?.versionId,
      decision: 'approve',
      note: 'approve this version',
    });
    const applied = await worker.applyOnce(taskId);
    if (!('applied' in applied)) throw new Error(`apply: ${JSON.stringify(applied)}`);
    await asAda('task.receipt', { attemptId: applied.applied.attemptId });
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  it('a whole journey through the application leaves no NOTIFY in the runtime log', () => {
    const text = runtime()
      .map((entry) => entry.text)
      .join('\n');
    // The capture is real: the journey's writes are in it.
    expect(text).toMatch(/insert into (public\.)?gate_decisions/iu);
    expect(text).toMatch(/insert into (public\.)?reservations/iu);
    expect(text).toMatch(/insert into (public\.)?run_events/iu);
    expect(runtime().filter((entry) => NOTIFYING.test(entry.text))).toStrictEqual([]);
  });

  it('the check is not blind: a pg_notify sent on the runtime pool is caught', async () => {
    const before = runtime().length;
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await tx.query(`select pg_notify('t4_no_notify', 'planted')`);
    });
    const planted = runtime()
      .slice(before)
      .filter((entry) => NOTIFYING.test(entry.text));
    expect(planted.map((entry) => entry.text)).toStrictEqual([
      `select pg_notify('t4_no_notify', 'planted')`,
    ]);
  });
});
