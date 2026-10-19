// SPDX-License-Identifier: AGPL-3.0-only
//
// A turn whose answer the worker never saw ends `ANSWER_LOST`, never success
// (R1706-F1, design D1/R1). The shipped agent runner computes an accepted plan
// through the real agent door. When the reply to the first `model.call` is
// lost in transit, the worker asks again under the same operation id and the
// door replays the call from its ledger, with no words. When the send is not
// ok, the door answers 2xx with the call's outcome and no words. Either way
// the turn ends there: no `'undefined'` text is taken as the model's answer,
// nothing is handed back, and no `COMPLETED` is recorded.

import { beforeAll, describe, expect, it } from 'vitest';
import type { Transport } from '../../apps/cli/client.ts';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import { REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import { acceptedPlan, verbsOf, type Seam } from './compute-seam-world.ts';
import { agentBroker, ownSiteOf, OWN_PAGE, replied } from './agent-draft-world.ts';
import { outcomesOf, s, useStopWorld, world } from './run-stop-world.ts';

useStopWorld('answerlost');

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await ownSiteOf(s, OWN_PAGE);
}, 180_000);

/** The door answers the first `model.call`, and the reply never reaches the worker. */
const losingFirstTurn = (transport: Transport): Transport => {
  let lost = false;
  return async (path, body, bearer, delegation) => {
    const response = await transport(path, body, bearer, delegation);
    if (lost || !path.endsWith('/model/call')) return response;
    lost = true;
    throw new Error('the reply was lost in transit');
  };
};

/** What the worker sent after the turn: never a turn carrying `'undefined'` as words. */
const afterTurn = (seam: Seam): readonly string[] =>
  seam.log.slice(verbsOf(seam).lastIndexOf('model.call') + 1).map((sent) => sent.verb);

describe.skipIf(serverUrl === undefined)('a turn whose answer words never reach the worker', () => {
  it('a reply lost and replayed from the ledger ends ANSWER_LOST, never COMPLETED', async () => {
    const seam = await acceptedPlan(
      'the about page spells the town wrong',
      agentRunner({ operation: REPLAY_TURN.key }),
      agentBroker(),
      losingFirstTurn,
    );
    world.provider.script([replied('Nothing to change.')]);
    const seen = world.provider.seen.length;
    const outcome = await seam.worker.applyOnce(seam.taskId);

    const turns = seam.log.filter((sent) => sent.verb === 'model.call');
    expect(turns, 'setup: the turn was asked again under its operation id').toHaveLength(2);
    expect(turns[1]?.body['operationId']).toBe(turns[0]?.body['operationId']);
    expect(turns[1]?.detail, 'setup: the replay has no words').not.toHaveProperty('text');
    expect(world.provider.seen.length - seen, 'setup: the provider was sent the turn once').toBe(1);

    expect(outcome).not.toHaveProperty('handedBack');
    expect(outcome).toMatchObject({ ended: { endCode: 'ANSWER_LOST' } });
    expect(afterTurn(seam)).toStrictEqual(['run.end']);
    expect(JSON.stringify(seam.log.map((sent) => sent.body))).not.toContain('undefined');
    expect(await outcomesOf(seam.work())).toMatchObject([
      { outcome: 'unknown_provider_outcome', end_code: 'ANSWER_LOST' },
    ]);
  }, 120_000);

  it('a send that is not ok ends ANSWER_LOST, its own recorded outcome kept and no COMPLETED', async () => {
    const seam = await acceptedPlan(
      'the about page spells the town wrong',
      agentRunner({ operation: REPLAY_TURN.key }),
      agentBroker(),
    );
    world.provider.mode('rate_limited');
    try {
      const outcome = await seam.worker.applyOnce(seam.taskId);

      const turns = seam.log.filter((sent) => sent.verb === 'model.call');
      expect(
        turns.map((sent) => [sent.status, sent.detail]),
        'setup: a 2xx with no words',
      ).toMatchObject([[200, { outcome: 'CALL_RELEASED' }]]);
      expect(turns[0]?.detail).not.toHaveProperty('text');

      expect(outcome).not.toHaveProperty('handedBack');
      expect(outcome).toMatchObject({ ended: { endCode: 'ANSWER_LOST' } });
      expect(afterTurn(seam)).toStrictEqual(['run.end']);
      expect(JSON.stringify(seam.log.map((sent) => sent.body))).not.toContain('undefined');
      expect(await outcomesOf(seam.work())).toMatchObject([
        { outcome: 'cancelled', end_code: 'PROVIDER_NOTHING_HAPPENED' },
      ]);
    } finally {
      world.provider.mode('answer');
    }
  }, 120_000);
});
