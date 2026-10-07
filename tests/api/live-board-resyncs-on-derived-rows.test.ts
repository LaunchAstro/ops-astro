// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f's one rule says `resync` when what the reader's board read shows
// moved. A board row shows more than its task row: the Actual total summed
// from time entries, the approval wait of a pending gate until its deadline,
// and the state and assignee it names. Each of these can change while the
// task row stays as it was, a gate's deadline with no write at all, and an
// open board on a quiet stream must still hear of it on the stream's recheck.
//
// The tab belongs to a reader with an empty inbox, so only the board's own
// digest can move.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectListener } from '../../packages/core-records/src/index.ts';
import type { Hono } from 'hono';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { authorised, BUSINESS_KEY, ISSUER, tokenFor } from './fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Row {
  readonly id: string;
  readonly actualMinutes: number;
  readonly waitReason: string | null;
  readonly state: { readonly label: string } | null;
  readonly assignee: { readonly name: string } | null;
}

interface Tab {
  resyncs(): number;
  stop(): Promise<void>;
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

// eslint-disable-next-line max-lines-per-function -- one database world and its open tabs, and the cases that share them
describe.skipIf(serverUrl === undefined)('an open board resyncs on what its rows derive', () => {
  let c: Controls;
  let topics: LiveTopics;
  let api: Hono;

  beforeAll(async () => {
    c = await createControls('board_derived_rows');
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, c.manager, 'write', WHOLE_BUSINESS, false, 'time');
    });
    topics = await startLiveTopics(connectListener(c.fixture.db.appUrl));
    api = composeApi({
      database: c.fixture.db.app,
      admin: c.fixture.db.admin,
      signIn: testSignIn(ISSUER),
      keys: runtimeKeys({ ...c.fixture.environment }),
      live: { topics, recheckMs: 20 },
    }).app;
  }, 180_000);

  afterAll(async () => {
    await topics?.close();
    await c?.drop();
  });

  /** The reader's tab, once it has heard its first resync and then nothing for a while. */
  const openQuiet = async (who: Member): Promise<Tab> => {
    const response = await api.request(`/api/b/${BUSINESS_KEY}/live`, {
      headers: authorised(await tokenFor(who.presented.subject)),
    });
    expect(response.status).toBe(200);
    const stream = response.body!.getReader();
    const frames: string[] = [];
    const draining = (async () => {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- one frame after the next
        const frame = await stream.read();
        if (frame.done) return;
        frames.push(new TextDecoder().decode(frame.value));
      }
    })();
    const tab: Tab = {
      resyncs: () => frames.join('').match(/event: resync/gu)?.length ?? 0,
      stop: async () => {
        await stream.cancel();
        await draining;
      },
    };
    await expect.poll(() => tab.resyncs(), { timeout: 10_000 }).toBeGreaterThan(0);
    for (let heard = tab.resyncs(); ; heard = tab.resyncs()) {
      // eslint-disable-next-line no-await-in-loop -- until two rechecks' worth of nothing
      await sleep(200);
      if (tab.resyncs() === heard) return tab;
    }
  };

  const rowOf = async (taskId: string): Promise<Row | undefined> => {
    const answer = await executeRead(c.fixture.db.app, c.fixture.business, c.reader.presented, {
      read: 'task.board',
      board: null,
    });
    return (answer as { readonly tasks?: readonly Row[] }).tasks?.find((row) => row.id === taskId);
  };

  it('a time entry logged on a served task, its row untouched, resyncs to the new Actual total', async () => {
    const task = await c.createTask('logged while the board is open');
    const tab = await openQuiet(c.reader);
    try {
      expect((await rowOf(task.id))?.actualMinutes).toBe(0);
      const before = tab.resyncs();
      const logged = await c.asPerson('time.log', { taskId: task.id, duration: '45m', note: '' });
      expect(logged.status, JSON.stringify(logged.body)).toBe(200);
      await expect.poll(() => tab.resyncs(), { timeout: 10_000 }).toBeGreaterThan(before);
      expect((await rowOf(task.id))?.actualMinutes).toBe(45);
    } finally {
      await tab.stop();
    }
  });

  it('a pending gate that expires with no write clears its approval wait on the recheck', async () => {
    const task = await c.createTask('a gate expiring while the board is open');
    const proposal = await c.propose(task.id, task.revision, 'expiring_gate');
    await c.fixture.db.admin.execute(
      `update public.gates set expires_at = clock_timestamp() + interval '2 seconds'
        where id = $1`,
      [proposal['gateId']],
    );
    const tab = await openQuiet(c.reader);
    try {
      expect((await rowOf(task.id))?.waitReason).toBe('needs_approval');
      const before = tab.resyncs();
      await expect.poll(() => tab.resyncs(), { timeout: 10_000 }).toBeGreaterThan(before);
      expect((await rowOf(task.id))?.waitReason).toBeNull();
    } finally {
      await tab.stop();
    }
  });

  it('a rename of the state or the assignee a served row names resyncs to the new name', async () => {
    const task = await c.createTask('naming its state and assignee');
    const assigned = await c.asPerson('task.assign', {
      recordId: task.id,
      expectedRevision: task.revision,
      fields: { assignee: c.manager.personId },
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const tab = await openQuiet(c.reader);
    try {
      const shown = await rowOf(task.id);
      expect(shown?.state).not.toBeNull();
      let before = tab.resyncs();
      const person = `Renamed ${randomUUID().slice(0, 8)}`;
      await c.fixture.db.admin.execute('update public.people set display_name = $2 where id = $1', [
        c.manager.personId,
        person,
      ]);
      await expect.poll(() => tab.resyncs(), { timeout: 10_000 }).toBeGreaterThan(before);
      expect((await rowOf(task.id))?.assignee?.name).toBe(person);

      before = tab.resyncs();
      const label = `Relabelled ${randomUUID().slice(0, 8)}`;
      await c.fixture.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('label', $2::text)
          where id = (select uuid_1 from public.records where id = $1)`,
        [task.id, label],
      );
      await expect.poll(() => tab.resyncs(), { timeout: 10_000 }).toBeGreaterThan(before);
      expect((await rowOf(task.id))?.state?.label).toBe(label);
    } finally {
      await tab.stop();
    }
  });

  it('a write to the assignee or state that a served row does not show says nothing', async () => {
    const task = await c.createTask('its assignee steps up a sign-in');
    const assigned = await c.asPerson('task.assign', {
      recordId: task.id,
      expectedRevision: task.revision,
      fields: { assignee: c.manager.personId },
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const tab = await openQuiet(c.reader);
    try {
      const before = tab.resyncs();
      // What a second factor verified, removed or reset writes on the person's row.
      await c.fixture.db.admin.execute(
        'update public.people set second_factor_verified = not second_factor_verified where id = $1',
        [c.manager.personId],
      );
      await c.fixture.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('description', $2::text)
          where id = (select uuid_1 from public.records where id = $1)`,
        [task.id, `unshown ${randomUUID().slice(0, 8)}`],
      );
      await sleep(600);
      expect(tab.resyncs()).toBe(before);
    } finally {
      await tab.stop();
    }
  });
});
