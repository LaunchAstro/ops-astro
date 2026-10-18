// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P11 (design v3, Step 3 and director question 3): a definition's class
// is its run's task's. (a) `definition.read` names the task in the register
// without writing its data, so an owner-entered internal task stays internal
// after the read and its [definition, task] turn takes the cloud route.
// (b) An outside task's [definition]-only turn takes only the local route: the
// definition carries the task's class, never business-internal of its own.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { s, signedIn } from './run-stop-door-world.ts';
import {
  definitionPart,
  ENTRY,
  pinnedWork,
  readOk,
  routesOf,
  useDefinitionWorld,
} from './definition-world.ts';
import { sendTurn, settledOnce } from './definition-turns.ts';
import { taskPart } from './turn-world.ts';

describe.skipIf(serverUrl === undefined)("a definition and its task's class", () => {
  useDefinitionWorld('defclass');

  it('a: an owner-entered internal task, after definition.read, still takes the cloud route', async () => {
    const on = await pinnedWork('definition class internal');
    const as = await signedIn();
    await readOk(on, as, ENTRY);
    // Mutation: remove `definition.read` from `LEAVES_ROW_DATA` -> the read makes the task outside, local, red.
    const turn = await sendTurn(on, [definitionPart(ENTRY), await taskPart(on.work)], as);
    settledOnce(turn);
    expect(await routesOf(on.work)).toEqual(['cloud']);
  }, 60_000);

  it("b: an outside task's [definition]-only turn takes only the local route", async () => {
    const on = await pinnedWork('definition class outside');
    // An agent's write makes the task outside (owner line 72): no longer business-internal.
    await s.db.admin.execute(
      `insert into public.operations (business_id, id, operation_id, actor_id, command, record_id,
                                      outcome, payload_digest, result)
       values ($1, gen_random_uuid(), $2, $3, 'task.update', $4, 'applied', repeat('0', 64), '{}')`,
      [s.business, randomUUID(), s.agentActorId, on.work.taskId],
    );
    const as = await signedIn();
    await readOk(on, as, ENTRY);
    // Mutation: give the definition part `business_internal` -> the cloud route, red.
    settledOnce(await sendTurn(on, [definitionPart(ENTRY)], as));
    expect(await routesOf(on.work)).toEqual(['local']);
  }, 60_000);
});
