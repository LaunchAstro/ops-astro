// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's run state (0201): each revision of a run's knowledge and unknowns
// is a version, kept with its actor and never rewritten. The table holds a
// run on its own task only, one row per version, in its own business, and the
// application may insert and read it, never update or delete it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { plannedTask, signed } from '../api/c54-fixture.ts';

interface Run {
  readonly id: string;
  readonly task_id: string;
}

/** The Postgres code a statement is refused with, or `applied`. */
const refusal = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'applied';
  } catch (error) {
    return String((error as { readonly code?: string }).code ?? error);
  }
};

// eslint-disable-next-line max-lines-per-function -- one world, each guarantee on it
describe.skipIf(serverUrl === undefined)('MP-6-2 run states table', () => {
  let world: World;
  let run: Run;
  let other: Run;

  beforeAll(async () => {
    world = await createWorld('mp62states');
    const ada = signed(world.ada);
    const runOf = async (taskId: string): Promise<Run> => {
      const rows = await world.db.admin.execute<Run>(
        `select id, task_id from public.planned_runs where task_id = $1 limit 1`,
        [taskId],
      );
      if (rows[0] === undefined) throw new Error('mp-6-2: no run on the approved task');
      return rows[0];
    };
    run = await runOf(await plannedTask(world, ada));
    other = await runOf(await plannedTask(world, ada));
  }, 120_000);

  afterAll(async () => await world?.close());

  /** One version as the application writes it, in `business`. */
  const insert = async (business: string, on: Run, version: number) =>
    await world.db.app.withBusiness(business as never, (tx) =>
      tx.query(
        `insert into public.run_states
           (business_id, id, run_id, task_id, version, knowledge, unknowns, revised_by_actor_id)
         values ($1, $2, $3, $4, $5, '["the reply is drafted"]', '["the client''s tone"]', $6)
         returning id`,
        [business, randomUUID(), on.id, on.task_id, version, world.ada.actorId],
      ),
    );

  it('MP-6-2 revisions: a version is kept and read back with its actor', async () => {
    await insert(world.alpha, run, 1);
    const rows = await world.db.admin.execute<Record<string, unknown>>(
      `select version, knowledge, unknowns, revised_by_actor_id from public.run_states where run_id = $1`,
      [run.id],
    );
    // Driver rows are not plain objects, so the values are compared, not the prototypes.
    expect(rows).toEqual([
      {
        version: 1,
        knowledge: ['the reply is drafted'],
        unknowns: ["the client's tone"],
        revised_by_actor_id: world.ada.actorId,
      },
    ]);
  });

  it('MP-6-2 revisions: a version is never rewritten or removed, and one number is one version', async () => {
    expect(
      await refusal(() =>
        world.db.app.withBusiness(world.alpha, (tx) =>
          tx.query(`update public.run_states set knowledge = '[]' where run_id = $1`, [run.id]),
        ),
      ),
    ).not.toBe('applied');
    expect(
      await refusal(() =>
        world.db.app.withBusiness(world.alpha, (tx) =>
          tx.query(`delete from public.run_states where run_id = $1`, [run.id]),
        ),
      ),
    ).not.toBe('applied');
    expect(await refusal(() => insert(world.alpha, run, 1))).toBe('23505');
    expect(await refusal(() => insert(world.alpha, run, 0))).toBe('23514');
  });

  it('MP-6-2 isolation: a run is held on its own task only, and in its own business only', async () => {
    // The run named on another task: the key refuses it.
    expect(
      await refusal(() => insert(world.alpha, { id: run.id, task_id: other.task_id }, 2)),
    ).toBe('23503');
    // Written in bravo naming alpha's run: nothing in bravo keys it.
    expect(await refusal(() => insert(world.bravo, run, 2))).toBe('23503');
    // Read in bravo: none of alpha's versions.
    const seen = await world.db.app.withBusiness(world.bravo, (tx) =>
      tx.query(`select id from public.run_states`),
    );
    expect([...seen]).toStrictEqual([]);
  });
});
