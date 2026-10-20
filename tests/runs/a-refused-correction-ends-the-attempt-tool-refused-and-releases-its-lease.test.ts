// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for #2010 (S2010-1), copied with its assertions unchanged: the
// shipped agent runner asks a correction the door refuses (a replacement on
// two lines), and the attempt ends with a recorded valid outcome, cancelled
// `TOOL_REFUSED`, and its lease released, never an end code `run.end` refuses.

import { beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import { REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';
import { acceptedPlan } from './compute-seam-world.ts';
import { agentBroker, ownSiteOf, OWN_PAGE, replied, requestOf } from './agent-draft-world.ts';
import { authorityOf, outcomesOf, s, useStopWorld, world } from './run-stop-world.ts';

useStopWorld('sol2010refusal');
beforeAll(async () => {
  if (serverUrl === undefined) return;
  await ownSiteOf(s, OWN_PAGE);
});

describe.skipIf(serverUrl === undefined)('a refused correction', () => {
  it('ends the attempt with a recorded valid outcome', async () => {
    const seam = await acceptedPlan(
      'fix the town',
      agentRunner({ operation: REPLAY_TURN.key }),
      agentBroker(),
    );
    world.provider.script([
      replied('Asking.', [
        {
          id: 'bad_word',
          name: 'live_correction.request',
          args: { ...requestOf(seam.taskId), replacement: 'two\nlines' },
        },
      ]),
    ]);
    const result = await seam.worker.applyOnce(seam.taskId);
    const refusal = seam.log.find((row) => row.verb === 'live_correction.request');
    expect(refusal?.status).not.toBe(200);
    const outcomes = await outcomesOf(seam.work());
    const authority = await authorityOf(seam.work());
    expect({ result, outcomes, authority }).toMatchObject({
      result: { ended: { outcome: 'cancelled', endCode: 'TOOL_REFUSED' } },
      outcomes: [{ outcome: 'cancelled', end_code: 'TOOL_REFUSED' }],
      authority: { lease: 'released' },
    });
  }, 120_000);
});
