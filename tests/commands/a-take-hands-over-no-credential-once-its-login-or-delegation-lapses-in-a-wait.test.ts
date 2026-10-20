// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.take_launch` hands over a run's credential only if the login and the
// delegation still stand after its last wait.
//
// A take waits twice: on the launch row, and later on the business's audit
// chain (`agent-standing.ts`). A login unlinked while it waits on the launch
// row is refused `AUTH_NO_AGENT_IDENTITY`, as a fresh call is, and so is a
// replay of a take that already started the launch. A delegation
// whose expiry passes while it waits on the audit chain hands over no
// credential either. Neither leaves the launch started. Another business's
// launch and a person's take are refused and change nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, holdRow, waiterOf, waitPast } from '../support/lock-wait-race.ts';
import { codeOf } from './agent-fixture.ts';
import { aiWorld, type AiWorld } from './ai-assign-world.ts';
import { launchedTask, launchOf, take, takenAs } from './take-launch-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)(
  'a take judges its login and delegation after its waits',
  // eslint-disable-next-line max-lines-per-function -- one database world, the staged waits and their cases
  () => {
    let w: AiWorld;
    beforeAll(async () => {
      w = await aiWorld('takelapse');
    }, 180_000);
    afterAll(async () => {
      await w?.world.drop();
    });

    it('a login unlinked while the take waits for the launch row receives no run credential', async () => {
      const task = await launchedTask(w, 'Unlinked login');
      const launch = await launchOf(w, task);
      const held = await holdRow(
        w.world.db,
        'select 1 from public.task_launches where id = $1 for update',
        [launch.id],
      );
      let answer;
      try {
        const taking = take(w, launch.id);
        await waiterOf(w.world.db, held);
        await w.world.db.admin.execute(
          'update public.actor_logins set active = false, deactivated_at = clock_timestamp() where actor_id = $1',
          [w.world.agentActorId],
        );
        await held.letGo();
        answer = await taking;
      } finally {
        await held.letGo();
      }
      expect(codeOf(await take(w, launch.id))).toBe('AUTH_NO_AGENT_IDENTITY');
      expect(typeof takenAs(answer)['credential'] === 'string').toBe(false);
      expect((await launchOf(w, task)).state).not.toBe('started');
    }, 30_000);

    it('a take replayed while the login is unlinked during its launch-row wait receives no run credential', async () => {
      await w.world.db.admin.execute(
        'update public.actor_logins set active = true, deactivated_at = null where actor_id = $1',
        [w.world.agentActorId],
      );
      const task = await launchedTask(w, 'Unlinked on replay');
      const launch = await launchOf(w, task);
      const body = { command: 'task.take_launch', operationId: randomUUID(), launchId: launch.id };
      expect(typeof takenAs(await w.world.asAgent(body))['credential']).toBe('string');
      const held = await holdRow(
        w.world.db,
        'select 1 from public.task_launches where id = $1 for update',
        [launch.id],
      );
      let answer;
      try {
        const replaying = w.world.asAgent(body);
        await waiterOf(w.world.db, held);
        await w.world.db.admin.execute(
          'update public.actor_logins set active = false, deactivated_at = clock_timestamp() where actor_id = $1',
          [w.world.agentActorId],
        );
        await held.letGo();
        answer = await replaying;
      } finally {
        await held.letGo();
      }
      expect(codeOf(answer)).toBe('AUTH_NO_AGENT_IDENTITY');
      expect(typeof takenAs(answer)['credential'] === 'string').toBe(false);
    }, 30_000);

    it('another business and a person cannot take the agent launch', async () => {
      await w.world.db.admin.execute(
        'update public.actor_logins set active = true, deactivated_at = null where actor_id = $1',
        [w.world.agentActorId],
      );
      const foreign = await aiWorld('takelapseforeign');
      try {
        const task = await launchedTask(foreign, 'Foreign business');
        const launch = await launchOf(foreign, task);
        const crossing = await take(w, launch.id);
        const fabricated = await take(w, randomUUID());
        expect(crossing).toEqual(fabricated);
        expect(codeOf(crossing)).toBe('SCOPE_NOT_GRANTED');
        expect(
          codeOf(
            await foreign.world.asPerson(foreign.p, {
              command: 'task.take_launch',
              operationId: randomUUID(),
              launchId: launch.id,
            }),
          ),
        ).toBe('SCOPE_NOT_GRANTED');
        expect(await launchOf(foreign, task)).toEqual(launch);
      } finally {
        await foreign.world.drop();
      }
    }, 180_000);

    it('a delegation that expires while the take waits for the audit chain hands over no run credential', async () => {
      await w.world.db.admin.execute(
        'update public.actor_logins set active = true, deactivated_at = null where actor_id = $1',
        [w.world.agentActorId],
      );
      const task = await launchedTask(w, 'Expiry at final wait');
      const launch = await launchOf(w, task);
      const [expiry] = await w.world.db.admin.execute<{ at: string }>(
        "update public.delegations set expires_at = clock_timestamp() + interval '3 seconds' where id = $1 returning expires_at::text as at",
        [launch.delegationId],
      );
      const held = await hold(w.world.db, async (execute) => {
        await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [w.world.business]);
      });
      let answer;
      try {
        const taking = take(w, launch.id);
        await waiterOf(w.world.db, held);
        await waitPast(w.world.db, expiry!.at);
        await held.letGo();
        answer = await taking;
      } finally {
        await held.letGo();
      }
      const [after] = await w.world.db.admin.execute<{ expired: boolean }>(
        'select expires_at <= clock_timestamp() as expired from public.delegations where id = $1',
        [launch.delegationId],
      );
      expect(after?.expired).toBe(true);
      expect(typeof takenAs(answer)['credential'] === 'string').toBe(false);
      expect(takenAs(answer)['state']).not.toBe('started');
      expect((await launchOf(w, task)).state).not.toBe('started');
    }, 30_000);
  },
);
