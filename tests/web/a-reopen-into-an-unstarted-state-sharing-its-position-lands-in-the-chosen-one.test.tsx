// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Two unstarted states may share a position. Leaving Complete for the one
// the task read lists first reopens the task, and the reopen must land in that
// same state, since the select sends no state write after it: the read and the
// command order the states alike.

import { act } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { timeWorld, type TimeWorld } from '../commands/time-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StatusField } from '../../apps/web/src/screens/task/StatusField.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import type { InternalTaskDetail, TaskStateView } from '../../packages/core-wire/src/index.ts';

type WireTaskRead =
  | { readonly task: InternalTaskDetail; readonly states: readonly TaskStateView[] }
  | Record<string, never>;

const READY_EXTRA = '00000000-0000-4000-8000-000000000010';

/** A second unstarted state at Needs review's position, whose id sorts first. */
async function addEqualPositionState(w: TimeWorld): Promise<void> {
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(
      `insert into records(business_id,id,record_type_id,data)
      select business_id,'${READY_EXTRA}',record_type_id,
        jsonb_build_object('key','ready_extra','label','Ready','machine_category','unstarted','position',1000)
      from records where business_id=$1 and data->>'key'='needs_review'`,
      [w.alpha],
    );
  });
}

/** The production client, its reopen and state writes run through the command envelope. */
function envelopeClient(w: TimeWorld): OperationsClient {
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (url, init) => {
      const command = String(url).endsWith('/task/reopen') ? 'task.reopen' : 'task.set_state';
      const answer = await executeCommand(w.db.app, w.alpha, w.ada.presented, 'api', {
        command,
        ...JSON.parse(String(init?.body)),
      });
      return json(answer, 'refused' in answer ? 409 : 200);
    },
  });
}

/** `task.read` as the page receives it over the wire. */
async function readTask(w: TimeWorld, id: string): Promise<WireTaskRead> {
  const read = await executeRead(w.db.app, w.alpha, w.ada.presented, {
    read: 'task.read',
    recordId: id,
  });
  return JSON.parse(JSON.stringify(read)) as WireTaskRead;
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a reopen into an unstarted state sharing its position',
  () => {
    let w: TimeWorld;
    beforeAll(async () => {
      w = await timeWorld('reopenequalposition');
    }, 180_000);
    afterAll(async () => {
      await w?.db.drop();
    });
    afterEach(unmountAll);

    it('lands in the state chosen, the one the read lists first', async () => {
      const id = await w.fresh(w.alpha, w.ada, 'State order proof');
      const completed = await w.as(w.alpha, w.ada, {
        command: 'task.complete',
        recordId: id,
        expectedRevision: 1,
      });
      expect('refused' in completed).toBe(false);
      await addEqualPositionState(w);
      const read = () => readTask(w, id);
      const first = await read();
      if (!('task' in first) || !('states' in first)) throw new Error('missing task/states');
      const states = first.states;
      const wanted = states.find((s) => s.machineCategory === 'unstarted');
      if (!wanted) throw new Error('missing choice');
      expect(wanted.id).toBe(READY_EXTRA);
      let changed = 0;
      const view = await mount(
        <StatusField
          client={envelopeClient(w)}
          task={first.task}
          states={states}
          id="status"
          onChanged={() => changed++}
        />,
      );
      await view.choose('select', wanted.id);
      await act(async () => {
        await expect.poll(() => changed).toBe(1);
      });
      await tick();
      const after = await read();
      if (!('task' in after)) throw new Error('missing result');
      expect(after.task.state?.id, 'reopening must land on the state explicitly selected').toBe(
        wanted.id,
      );
    });
  },
);
