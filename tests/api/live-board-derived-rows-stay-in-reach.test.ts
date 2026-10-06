// SPDX-License-Identifier: AGPL-3.0-only
//
// An open board's digest takes what its rows derive from other rows: the
// Actual total from time entries, the approval wait of a pending gate, and
// the state and assignee each row names. It takes them only for the tasks the
// reader is served. Here a hidden task, under another client of the same
// business or in another business, has time logged, its gate expire, and its
// own state and assignee renamed, none of them shared with the reader's task;
// the reader's quiet stream says nothing.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectListener,
  createClient,
  type BusinessId,
} from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { authorised, BUSINESS_KEY, ISSUER, post, tokenFor } from './fixture.ts';
import { createControls, PROPOSAL, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Row {
  readonly id: string;
  readonly actualMinutes: number;
  readonly waitReason: string | null;
  readonly state: { readonly id: string; readonly label: string } | null;
  readonly assignee: { readonly personId: string; readonly name: string } | null;
}

interface Tab {
  resyncs(): number;
  stop(): Promise<void>;
}

/** A task in `businessKey`, worked by `owner`, assigned to `assignee`, started, and waiting at a gate. */
interface Hidden {
  readonly businessKey: string;
  readonly business: BusinessId;
  readonly owner: Member;
  readonly assignee: Member;
  readonly taskId: string;
  readonly gateId: string;
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

// eslint-disable-next-line max-lines-per-function -- one database world and its open tabs, and the cases that share them
describe.skipIf(serverUrl === undefined)('an open board hears nothing of a hidden task', () => {
  let c: Controls;
  let topics: LiveTopics;
  let api: Hono;

  const as = async (
    businessKey: string,
    who: Member,
    name: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const answer = await post(
      api,
      `/api/b/${businessKey}/${name.replace('.', '/')}`,
      { operationId: randomUUID(), ...body },
      authorised(await tokenFor(who.presented.subject)),
    );
    expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(200);
    return answer.body;
  };

  const revisionOf = async (taskId: string): Promise<number> => {
    const rows = await c.fixture.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [taskId],
    );
    return Number(rows[0]?.revision);
  };

  const linkToClient = async (taskId: string, clientId: string): Promise<void> => {
    await c.fixture.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('client', $2::text)
        where id = $1`,
      [taskId, clientId],
    );
  };

  /** Its task created, assigned, started (so its state is not the reader's) and proposed. */
  const hiddenTask = async (
    businessKey: string,
    business: BusinessId,
    owner: Member,
    assignee: Member,
  ): Promise<Hidden> => {
    const made = await as(businessKey, owner, 'task.create', { fields: { title: 'hidden' } });
    const taskId = String(made['recordId']);
    await as(businessKey, owner, 'task.assign', {
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      fields: { assignee: assignee.personId },
    });
    await as(businessKey, owner, 'task.start', {
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
    });
    const proposed = await as(businessKey, owner, 'task.propose', {
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      ...PROPOSAL,
    });
    const detail = proposed['detail'] as Record<string, unknown>;
    return { businessKey, business, owner, assignee, taskId, gateId: String(detail['gateId']) };
  };

  const rowsOf = async (business: BusinessId, who: Member): Promise<readonly Row[]> => {
    const answer = await executeRead(c.fixture.db.app, business, who.presented, {
      read: 'task.board',
      board: null,
    });
    return (answer as { readonly tasks?: readonly Row[] }).tasks ?? [];
  };

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

  /** The reader is served their task and not the hidden one, which waits and names its own state and assignee. */
  const expectApart = async (reader: Member, readerTask: string, hidden: Hidden): Promise<void> => {
    const served = await rowsOf(c.fixture.business, reader);
    expect(served.map((row) => row.id)).toContain(readerTask);
    expect(served.map((row) => row.id)).not.toContain(hidden.taskId);
    const before = (await rowsOf(hidden.business, hidden.owner)).find(
      (row) => row.id === hidden.taskId,
    );
    const mine = served.find((row) => row.id === readerTask);
    expect(before?.waitReason).toBe('needs_approval');
    expect(before?.state?.id).not.toBe(mine?.state?.id);
    expect(before?.assignee?.personId).not.toBe(mine?.assignee?.personId);
  };

  /** The hidden task stirred under `reader`'s quiet board, which hears nothing while its owner reads it all. */
  const stirUnheard = async (reader: Member, readerTask: string, hidden: Hidden): Promise<void> => {
    await expectApart(reader, readerTask, hidden);
    await c.fixture.db.admin.execute(
      `update public.gates set expires_at = clock_timestamp() + interval '2 seconds'
        where id = $1`,
      [hidden.gateId],
    );
    const expires = Date.now() + 2_000;
    const tab = await openQuiet(reader);
    try {
      const heard = tab.resyncs();
      await as(hidden.businessKey, hidden.owner, 'time.log', {
        taskId: hidden.taskId,
        duration: '45m',
        note: '',
      });
      const person = `Renamed ${randomUUID().slice(0, 8)}`;
      await c.fixture.db.admin.execute('update public.people set display_name = $2 where id = $1', [
        hidden.assignee.personId,
        person,
      ]);
      const label = `Relabelled ${randomUUID().slice(0, 8)}`;
      await c.fixture.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('label', $2::text)
          where id = (select uuid_1 from public.records where id = $1)`,
        [hidden.taskId, label],
      );
      await sleep(Math.max(0, expires - Date.now()) + 800);
      expect(tab.resyncs()).toBe(heard);
      const after = (await rowsOf(hidden.business, hidden.owner)).find(
        (row) => row.id === hidden.taskId,
      );
      expect(after).toMatchObject({
        actualMinutes: 45,
        waitReason: null,
        state: { label },
        assignee: { name: person },
      });
    } finally {
      await tab.stop();
    }
  };

  beforeAll(async () => {
    c = await createControls('board_derived_reach');
    topics = await startLiveTopics(connectListener(c.fixture.db.appUrl));
    api = composeApi({
      database: c.fixture.db.app,
      admin: c.fixture.db.admin,
      signIn: testSignIn(ISSUER),
      keys: runtimeKeys({ ...c.fixture.environment }),
      live: { topics, recheckMs: 20 },
    }).app;
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, c.manager, 'write', WHOLE_BUSINESS, false, 'time');
    });
  }, 180_000);

  afterAll(async () => {
    await topics?.close();
    await c?.drop();
  });

  it('client to client: time, a gate expiring and names on client B’s task never move client A’s reader’s board', async () => {
    const { app: db } = c.fixture.db;
    const { business } = c.fixture;
    const clients: string[] = [];
    await db.withBusiness(business, async (tx) => {
      for (const name of [`Client A ${randomUUID()}`, `Client B ${randomUUID()}`]) {
        // eslint-disable-next-line no-await-in-loop -- one transaction's statements in turn
        const made = await createClient(tx, name, c.manager.actorId);
        if (!made.ok) throw new Error(`createClient refused ${JSON.stringify(made.refusal)}`);
        clients.push(made.value);
      }
    });
    const [clientA, clientB] = clients as [string, string];
    const taskA = await c.createTask('client A’s task');
    await linkToClient(taskA.id, clientA);
    const assigneeB = await enrol(db, business, 'client B’s assignee');
    const hidden = await hiddenTask(BUSINESS_KEY, business, c.manager, assigneeB);
    await linkToClient(hidden.taskId, clientB);
    const readerA = await enrol(db, business, 'client A reader');
    const readerB = await enrol(db, business, 'client B reader');
    await db.withBusiness(business, async (tx) => {
      // The board serves by record; the stream's reach also walks the client.
      await grantTo(tx, readerA, 'read', { kind: 'record', id: taskA.id });
      await grantTo(tx, readerA, 'read', { kind: 'party', id: clientA });
      await grantTo(tx, readerB, 'read', { kind: 'record', id: hidden.taskId });
    });
    expect((await rowsOf(business, readerB)).map((row) => row.id)).toEqual([hidden.taskId]);
    await stirUnheard(readerA, taskA.id, hidden);
  });

  it('business to business: time, a gate expiring and names on another business’s task never move this board', async () => {
    const db = c.fixture.db.app;
    const bravoKey = `bravo-${randomUUID().slice(0, 8)}`;
    const bravo = (await insertBusiness(db, bravoKey)) as BusinessId;
    await installSpine(db, bravo);
    const bravoOwner = await enrol(db, bravo, 'bravo owner');
    const bravoAssignee = await enrol(db, bravo, 'bravo assignee');
    await db.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign'] as const) {
        // eslint-disable-next-line no-await-in-loop -- `issueGrant` reads the granter's own rows
        await grantTo(tx, bravoOwner, action);
      }
      await grantTo(tx, bravoOwner, 'write', WHOLE_BUSINESS, false, 'time');
      await tx.query(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', 500000, 'AUD')`,
        [bravo, randomUUID()],
      );
    });
    const hidden = await hiddenTask(bravoKey, bravo, bravoOwner, bravoAssignee);
    // The alpha reader reads every task in alpha: only the business stands between.
    const own = await c.createTask('alpha’s own task');
    await stirUnheard(c.reader, own.id, hidden);
  });
});
