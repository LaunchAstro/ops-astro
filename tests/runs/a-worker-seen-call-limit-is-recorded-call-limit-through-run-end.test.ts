// SPDX-License-Identifier: AGPL-3.0-only
//
// #1911 S1911-1, the server's half: when LangChain's own limit stops the
// agent before the server's does, the worker ends its run through `run.end
// CALL_LIMIT_REACHED`, and the server records `call_limit / CALL_LIMIT_REACHED`
// once and retires the work. Its records must show the claim: an attempt with
// no settled call has made no call to be limited, so that end is refused
// `TRANSITION_NOT_PERMITTED` and nothing is written.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import {
  authorityOf,
  callsOf,
  modelCall,
  named,
  noDatabase,
  outcomesOf,
  runEnd,
  s,
  shapeOf,
  useStopWorld,
  world,
} from './run-stop-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('r4calllimitend');

const fresh = async (what: string): Promise<Work> =>
  await liveWork(s, `r4 ${what} ${randomUUID()}`, 2_000);

it('after a settled call, run.end CALL_LIMIT_REACHED records call_limit once and retires the work', async () => {
  const work = await fresh('local limit');
  world.provider.mode('answer');
  await modelCall(work);
  expect(await callsOf(work), 'setup: the call settled').toMatchObject([{ state: 'settled' }]);

  const ended = await runEnd(work, 'CALL_LIMIT_REACHED');
  expect(ended.body['code'], JSON.stringify(ended.body)).toBe('RUN_ENDED');
  expect(shapeOf(await outcomesOf(work))).toEqual([named('call_limit', 'CALL_LIMIT_REACHED')]);
  expect(await authorityOf(work)).toMatchObject({ lease: 'released', cause: 'work_retired' });
});

it('with no settled call, run.end CALL_LIMIT_REACHED is refused and writes nothing', async () => {
  const work = await fresh('no call');
  const ended = await runEnd(work, 'CALL_LIMIT_REACHED');
  expect(ended.body['code'], JSON.stringify(ended.body)).toBe('TRANSITION_NOT_PERMITTED');
  expect(await outcomesOf(work)).toEqual([]);
  expect(await authorityOf(work)).toMatchObject({ lease: 'live' });
});
