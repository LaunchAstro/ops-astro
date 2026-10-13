// SPDX-License-Identifier: AGPL-3.0-only
//
// A client linked to a paid conversation's page task while its send is in
// flight either stops the send or waits for it:
//
//   - linked after the context was read and before the handoff: the send is
//     not admitted, nothing goes, and the hold is freed;
//   - linked once the send is admitted: the link waits on the admission's
//     hold of the task (seen waiting) until custody has started, so the one
//     request was decided while the page had no client;
//   - the task row held by a writer at the handoff: nothing is admitted, at
//     once.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Admit, Custody } from '../../packages/core-custody/src/custody.ts';
import { slotOf, TASK_SPINE } from '../../packages/core-records/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdRow } from '../support/lock-wait-race.ts';
import { pricedWorld, type Asked, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();
const CLIENT = slotOf(TASK_SPINE, 'client');

/** Custody whose dispatch runs `before` first, and `admitted` once a send is admitted. */
const wrapping =
  (before: () => Promise<void>, admitted: () => Promise<void> = async () => undefined) =>
  (broker: PricedWorld['broker']): PricedWorld['broker'] => {
    const custody: Custody = broker.custody;
    const wrapAdmit = (admit: Admit | undefined): Admit | undefined =>
      admit === undefined
        ? undefined
        : async (sent) => {
            const ok = await admit(sent);
            if (ok) await admitted();
            return ok;
          };
    return {
      ...broker,
      custody: {
        ...custody,
        dispatch: async (ref, request, onPiece, admit) => {
          await before();
          return await custody.dispatch(ref, request, onPiece, wrapAdmit(admit));
        },
      },
    };
  };

// oxlint-disable-next-line max-lines-per-function -- one world, a schedule per way a link meets the send
describe.skipIf(serverUrl === undefined)('a client link racing the paid send', () => {
  let p: PricedWorld;
  let clientId: string;

  beforeAll(async () => {
    p = await pricedWorld('priced_client_race');
    clientId = randomUUID();
    await addClient(p.w.fixture.db.app, p.w.fixture.business, clientId, p.w.owner);
    await p.w.fixture.db.app.withBusiness(p.w.fixture.business, async (tx) => {
      await grantTo(tx, p.w.owner, 'share');
    });
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  /** A paid conversation on a task of its own, with no client. */
  async function onATask(): Promise<{ readonly asked: Asked; readonly taskId: string }> {
    const made = await p.w.as(p.w.owner, 'task.create', { fields: { title: 'Roster for May' } });
    const taskId = String(made.body['recordId']);
    const asked = await p.question('What is left?', undefined, {
      scope: { kind: 'task', id: taskId },
    });
    return { asked, taskId };
  }

  /** The task's client set by its own command, on a pool of its own so a wait holds up nobody's reads. */
  const link = async (taskId: string): Promise<void> => {
    const { db, business } = p.w.fixture;
    const [task] = await db.admin.execute<{ readonly revision: string }>(
      'select revision::text from public.records where id = $1',
      [taskId],
    );
    const own = connect(db.appUrl, { source: 'runtime' });
    const placed = await executeCommand(own, business, p.w.owner.presented, 'api', {
      command: 'task.set_party',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: Number(task?.revision),
      fields: { client: clientId },
    } as never);
    await own.close();
    expect(placed).toMatchObject({ recordId: taskId });
    const [after] = await db.admin.execute<{ readonly client: string | null }>(
      `select ${CLIENT}::text as client from public.records where id = $1`,
      [taskId],
    );
    expect(after?.client).toBe(clientId);
  };

  async function notAdmitted(asked: Asked, change: Parameters<PricedWorld['twin']>[0]) {
    const { db, business } = p.w.fixture;
    const before = await p.committed();
    const sent = p.openrouter.received.length;
    const exchange = await p.twin(change);
    expect(await exchange(db.app, business, p.w.owner.presented, asked)).toMatchObject({
      answered: false,
      code: 'CUSTODY_NOT_ADMITTED',
    });
    expect(p.openrouter.received.length).toBe(sent);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'released' }]);
    expect(await p.committed()).toBe(before);
  }

  it('linked after the context read, before the handoff: nothing sent, the hold freed', async () => {
    const { asked, taskId } = await onATask();
    await notAdmitted(
      asked,
      wrapping(async () => await link(taskId)),
    );
  });

  it('the task row held by a writer at the handoff: nothing admitted', async () => {
    const { asked, taskId } = await onATask();
    let held: Awaited<ReturnType<typeof holdRow>> | undefined;
    const lockTask = async (): Promise<void> => {
      held = await holdRow(
        p.w.fixture.db,
        'select 1 from public.records where id = $1 for update',
        [taskId],
      );
    };
    await notAdmitted(asked, wrapping(lockTask));
    await held?.letGo();
  });

  it('linked once the send is admitted: the link waits for the handoff; one request', async () => {
    const { db, business } = p.w.fixture;
    const { asked, taskId } = await onATask();
    const sent = p.openrouter.received.length;
    let linking: Promise<void> | undefined;
    let linked = false;
    const pendingAtAdmission: boolean[] = [];
    const startLinking = async (): Promise<void> => {
      linking = (async () => {
        await link(taskId);
        linked = true;
      })();
      for (let tries = 0; tries < 500; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polls the server
        const waiting = await p.w.count(
          `select count(*)::text as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
          [],
        );
        if (waiting > 0) {
          pendingAtAdmission.push(!linked);
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- polls the server
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      throw new Error('the link never waited on the admission');
    };
    const exchange = await p.twin(wrapping(async () => undefined, startLinking));
    await exchange(db.app, business, p.w.owner.presented, asked);
    await linking;
    expect(pendingAtAdmission).toStrictEqual([true]);
    expect(p.openrouter.received.length).toBe(sent + 1);
  });
});
