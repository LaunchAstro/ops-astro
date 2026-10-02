// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10: every model call names itself to its provider. The request a task's
// call sends carries the call's id as its operation id, so the reconciliation
// pass can later ask the provider about that one operation
// (`reconcileProviderCalls`). A person's conversation call and a planning
// reply carry their own call's id the same way, so a provider asked about
// them later can answer for exactly that call.

import { expect, it as vitestIt } from 'vitest';
import { callModelInConversation } from '../../packages/core-custody/src/index.ts';
import { REPLAY_PATH } from '../../packages/core-connectors/src/index.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, local, ownerOf, plan, rowsFor, usePlanningWorld } from './aw-04-planning-world.ts';
import { callIn, faultBroker } from './aw-10-world.ts';
import { liveWork, rows } from '../runtime/schedules-harness.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('aw10opid');

/** The operation id the provider was last sent on a call. */
function lastOperationId(): unknown {
  const sent = world.provider.seen.findLast((one) => one.path === REPLAY_PATH);
  return (JSON.parse(String(sent?.body)) as Record<string, unknown>)['operation_id'];
}

it("AW-10 operation id: a task's call, a conversation call and a planning reply each send the provider their own call's id", async () => {
  world.provider.mode('answer');
  const work = await liveWork(s, 'aw10 opid task', 2_000);
  await callIn(s, work, faultBroker());
  const [task] = await rows<{ id: string }>(
    s,
    `select id from public.model_calls where lease_id = $1`,
    [work.picked['leaseId']],
  );
  expect(lastOperationId()).toBe(task?.id);

  const talk = ask(s);
  await callModelInConversation(s.db.app, s.business, ownerOf(s), talk, local(s));
  const [conversation] = await rowsFor(s, talk.conversation.id);
  expect(lastOperationId()).toBe(conversation?.['id']);

  const planning = ask(s);
  await plan(s, ownerOf(s), planning);
  const [reply] = await rowsFor(s, planning.conversation.id);
  expect(lastOperationId()).toBe(reply?.['id']);
});
