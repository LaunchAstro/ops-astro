// SPDX-License-Identifier: AGPL-3.0-only
//
// A stop and an agent write at once never deadlock. The write's last
// judgement takes the presented delegation, the agent actor and its login
// mapping `for share`, then the audit chain and the session-ending keys; the
// stop takes the same rows in the same order, exclusively, then the subject
// key. Whichever reaches the first shared row first, the other waits behind
// it and finishes once it commits. Each case stops one of the two at one of
// its locks, shows the other parked behind it in `pg_blocking_pids`, then
// lets go: a deadlock would surface as `40P01` from either transaction.

import { afterEach, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, type Held } from '../support/lock-wait-race.ts';
import { codeOf, type AgentWorld } from './agent-fixture.ts';
import {
  finishStop,
  lockStop,
  pendingStop,
  STOP_LOCKS,
  stopCase,
  stopLock,
  stopWaitsBehindWrite,
  tracked,
  waitsBehind,
  WHOLE_STOP,
  type StopCase,
  type StopLock,
} from './agent-stop-shape.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'commands/agent-standing-lock-order: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const worlds: AgentWorld[] = [];

async function newCase(part: string): Promise<StopCase> {
  const test = await stopCase(part);
  worlds.push(test.world);
  return test;
}

/**
 * Where a third transaction parks the write inside its last judgement: each
 * lock it takes there after the delegation, in its order, held exclusively.
 */
const PARKERS = ['actor', 'mapping', 'chain', 'subject'] as const;

async function park(test: StopCase, at: StopLock | 'chain'): Promise<Held> {
  return await hold(test.world.db, async (execute) => {
    await (at === 'chain'
      ? execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [test.world.business])
      : execute(...stopLock(test.target, at)));
  });
}

describe.skipIf(serverUrl === undefined)('a stop and an agent write at once', () => {
  afterEach(async () => {
    await Promise.all(worlds.splice(0).map(async (world) => await world.drop()));
  });

  it.each(STOP_LOCKS)(
    'with the stop holding through its %s lock, the write waits behind it and is refused',
    async (through) => {
      const test = await newCase(`aslo_stop_${through}`);
      const stop = await hold(
        test.world.db,
        async (execute) => await lockStop(execute, test.target, through),
        async (execute) => await finishStop(execute, test.target, WHOLE_STOP, through),
      );
      const write = tracked(test.comment());

      const seen = await waitsBehind(test.world.db, stop, write.settled);
      await stop.letGo();

      expect(seen).toBe('waiting');
      expect(codeOf(await write.promise)).toBe('AUTH_NO_AGENT_IDENTITY');
    },
  );

  it.each(PARKERS)(
    'with the write parked at its %s lock, the stop waits behind it and the write lands',
    async (at) => {
      const test = await newCase(`aslo_write_${at}`);
      const parker = await park(test, at);
      const write = tracked(test.comment());
      const parked = await waitsBehind(test.world.db, parker, write.settled);
      expect(parked).toBe('waiting');

      const stop = await pendingStop(test.world.db, test.target);
      const stopping = tracked(stop.letGo());
      const seen = await stopWaitsBehindWrite(test.world.db, stop, parker, stopping.settled);
      await parker.letGo();
      const written = await write.promise;
      await stopping.promise;

      expect(seen).toBe('waiting behind the write');
      expect(isCommandRefusal(written)).toBe(false);
      expect(codeOf(await test.comment())).toBe('AUTH_NO_AGENT_IDENTITY');
    },
  );
});
