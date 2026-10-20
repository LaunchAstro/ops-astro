// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shutDown, shutdownStages } from '../../apps/api/server.ts';
import { startOccurrenceSweeper } from '../../apps/api/occurrence-sweeper.ts';
import { connect, insertActivation } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { firingOf, waitingOn } from './firing.ts';
import { startProcess } from './process-firing.ts';
import { prepareRuns } from './run-start.ts';
import { holdActivation, runsOf } from './sweep-race.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A released, adopted one-minute activation with a real worker and task spine. */
async function prepare(w: AutomationWorld): Promise<{ activationId: string; versionId: string }> {
  await prepareRuns(w);
  const version = await w.release(['scheduled']);
  const activation = await w.inAlpha((tx) =>
    insertActivation(tx, {
      versionId: version.id,
      mode: 'scheduled',
      everyMinutes: 1,
      eventKind: null,
      enabled: true,
      actorId: w.admin.actorId,
    }),
  );
  if (activation === null) throw new Error('process-firing: activation was not written');
  await firingOf(w).adopt(activation, version);
  return { activationId: activation.id, versionId: version.id };
}

const logState = (output: string, state: 'on' | 'off'): void => {
  expect(output.split('\n').filter((line) => line.includes('automation firing'))).toEqual([
    `api process: automation firing ${state}`,
  ]);
};

// oxlint-disable-next-line max-lines-per-function -- each case owns and cleans up its process and database
describe.skipIf(serverUrl === undefined)('automation firing at the API process entry', () => {
  let w: AutomationWorld;
  let activationId: string;
  let versionId: string;

  beforeEach(async () => {
    w = await createAutomationWorld('processfiring');
    ({ activationId, versionId } = await prepare(w));
  });

  afterEach(async () => {
    await w?.db.drop();
  });

  const counts = async () => ({
    occurrences: await w.occurrences(activationId),
    runs: await runsOf(w, activationId),
  });

  it('with the setting unset, an adopted one-minute activation stays idle past the next sweep', async () => {
    const api = await startProcess(w);
    try {
      // Real wall time covers the immediate pass and a complete one-minute interval.
      await delay(65_000);
      expect(api.gone, api.output).toBe(false);
      expect(await counts()).toEqual({ occurrences: 0, runs: 0 });
      logState(api.output, 'off');
    } finally {
      await api.stop();
    }
    expect(api.code).toBe(0);
  }, 90_000);

  it('with the exact on value, the adopted activation starts one occurrence and one pinned run', async () => {
    const api = await startProcess(w, 'on');
    try {
      await expect.poll(counts, { timeout: 10_000 }).toEqual({ occurrences: 1, runs: 1 });
      logState(api.output, 'on');
    } finally {
      await api.stop();
    }
    expect(api.code).toBe(0);
    expect(await counts()).toEqual({ occurrences: 1, runs: 1 });
    const pins = await w.db.admin.execute<{ version_id: string; definition_pin: string }>(
      `select o.version_id, p.definition_version_id as definition_pin
         from public.activation_occurrences o
         join public.planned_runs r on r.origin_occurrence_id = o.id and r.business_id = o.business_id
         join public.run_definition_pins p on p.run_id = r.id and p.business_id = r.business_id
        where o.activation_id = $1 and p.ref_kind = 'definition_version'`,
      [activationId],
    );
    expect(pins).toEqual([{ version_id: versionId, definition_pin: versionId }]);
  });

  it.each(['', 'off', 'ON', 'On', 'true', '1', ' on', 'on ', 'on\n'])(
    'with invalid setting %j, the due activation stays idle and the process logs off once',
    async (value) => {
      const api = await startProcess(w, value);
      try {
        await delay(500);
        expect(api.gone, api.output).toBe(false);
        expect(await counts()).toEqual({ occurrences: 0, runs: 0 });
        logState(api.output, 'off');
      } finally {
        await api.stop();
      }
      expect(api.code).toBe(0);
    },
  );

  it('shutdown waits for an on sweep blocked on a separate connection to commit', async () => {
    const held = await holdActivation(w, activationId);
    let api: Awaited<ReturnType<typeof startProcess>> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      api = await startProcess(w, 'on');
      await waitingOn(w, 1);
      stopping = api.stop();
      await delay(200);
      expect(api.gone).toBe(false);
      expect(await counts()).toEqual({ occurrences: 0, runs: 0 });
    } finally {
      await held.letGo();
      await (stopping ?? api?.stop());
    }
    expect(api?.code).toBe(0);
    expect(await counts()).toEqual({ occurrences: 1, runs: 1 });
    expect(api?.output).not.toContain('occurrence sweep:');
  });

  it('the API shutdown stages stop the running occurrence pass before either pool closes', async () => {
    const held = await holdActivation(w, activationId);
    const pool = connect(w.db.appUrl);
    const sweeper = startOccurrenceSweeper(pool, {
      businesses: async () => await Promise.resolve([w.alpha]),
    });
    const closed: string[] = [];
    let stopping: Promise<void> | undefined;
    try {
      await waitingOn(w, 1);
      stopping = shutDown(
        ...shutdownStages({
          topics: undefined,
          mail: undefined,
          conversations: undefined,
          occurrences: sweeper.stop,
          sweeper: undefined,
          tracer: undefined,
          broker: undefined,
          database: async () => {
            closed.push('database');
            await pool.close();
          },
          admin: async () => {
            closed.push('admin');
            await Promise.resolve();
          },
        }),
      );
      await delay(200);
      expect(closed).toEqual([]);
    } finally {
      await held.letGo();
      await stopping;
      await sweeper.stop();
      await pool.close();
    }
    expect(closed.toSorted()).toEqual(['admin', 'database']);
    expect(await counts()).toEqual({ occurrences: 1, runs: 1 });
  });
});
