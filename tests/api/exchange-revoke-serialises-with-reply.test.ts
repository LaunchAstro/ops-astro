// SPDX-License-Identifier: AGPL-3.0-only
//
// The review's proof (#819, criterion 5), renamed for what it proves and
// otherwise as written. The exchange's keep
// asks the conversation grant again under the conversation's row lock, then
// inserts the reply. The barrier is a lock: a separate session holds the
// person's message row `for update`, so keep's insert waits on its foreign key
// check after the grant SELECT has run. An administrator then revokes the
// owner's one conversation:write grant through `access.revoke` on its own
// connection. Either the two serialise, or a revocation that commits first
// leaves no reply.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const insertWaits = (rows: readonly { query: string }[]): boolean =>
  rows.some((row) => /insert into conversation_messages/u.test(row.query));

// eslint-disable-next-line max-lines-per-function -- one race, set up and watched in one case
describe.skipIf(serverUrl === undefined)('access.revoke and a reply being kept', () => {
  let w: ConversationWorld;
  let model: LocalModel;
  beforeAll(async () => {
    w = await conversationWorld('exchange_revoke_serialises');
    model = await localModel();
    // The administrator: the fixture's member, given access:manage.
    await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await grantTo(tx, w.owner, 'manage', undefined, false, 'access'),
    );
  }, 180_000);
  afterAll(async () => {
    await model?.close();
    await w?.drop();
  });

  // eslint-disable-next-line max-lines-per-function -- the review's proof, as written
  it('a revocation committed while the reply waits at its insert leaves no reply', async () => {
    const person = w.colleague;
    const opened = await w.as(person, 'conversation.start', { body: 'Revoked before the insert' });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    const grants = await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) =>
        await tx.query<{ id: string }>(
          "select id from grants where subject_id = $1 and collection = 'conversation' and action = 'write' and revoked_at is null",
          [person.personId],
        ),
    );
    expect(grants).toHaveLength(1);
    const grantId = grants[0]?.id as string;

    const watcher = connect(w.fixture.db.appUrl, { source: 'runtime' });
    const revoker = connect(w.fixture.db.appUrl, { source: 'runtime' });
    const waiting = async (): Promise<readonly { query: string }[]> =>
      await watcher.withBusiness(
        w.fixture.business,
        async (tx) =>
          await tx.query<{ query: string }>(
            `select query from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
          ),
      );

    // eslint-disable-next-line unicorn/consistent-function-scoping -- replaced below
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // eslint-disable-next-line unicorn/consistent-function-scoping -- replaced below
    let barrierHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      barrierHeld = resolve;
    });
    try {
      // The barrier: the person's message row locked, so the reply's foreign
      // key check (the insert at conversation-exchange.ts:158) waits on it.
      const barrier = w.fixture.db.admin.transaction(async (execute) => {
        const locked = await execute(
          'select id from public.conversation_messages where id = $1 for update',
          [asked.messageId],
        );
        expect(locked).toHaveLength(1);
        barrierHeld();
        await released;
      });
      await held;

      const replying = model.exchange(
        w.fixture.db.app,
        w.fixture.business,
        person.presented,
        asked,
      );
      let paused = false;
      for (let tries = 0; tries < 400 && !paused; tries += 1) {
        // eslint-disable-next-line no-await-in-loop -- watching the server for the lock wait
        paused = insertWaits(await waiting());
        // eslint-disable-next-line no-await-in-loop
        if (!paused) await sleep(25);
      }
      expect(paused).toBe(true);

      let settled = false;
      const revoking = executeCommand(revoker, w.fixture.business, w.owner.presented, 'api', {
        command: 'access.revoke',
        operationId: randomUUID(),
        grantId,
      }).then((result) => {
        settled = true;
        return isCommandRefusal(result) ? result.code : 'ok';
      });
      let revokeWaits = false;
      // eslint-disable-next-line no-unmodified-loop-condition -- settled is set by the revocation
      for (let tries = 0; tries < 400 && !settled && !revokeWaits; tries += 1) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await waiting();
        revokeWaits = rows.some((row) => !/insert into conversation_messages/u.test(row.query));
        // eslint-disable-next-line no-await-in-loop
        if (!settled && !revokeWaits) await sleep(25);
      }
      const revokedWhilePaused = settled;
      expect(settled || revokeWaits).toBe(true);

      release();
      await barrier;
      const [reply, revoked] = await Promise.all([replying, revoking]);
      expect(revoked).toBe('ok');
      const agentReplies = await w.count(
        "select count(*) as n from public.conversation_messages where conversation_id = $1 and role = 'agent'",
        [asked.conversationId],
      );

      const outcome = { revokedWhilePaused, reply, agentReplies };
      expect(outcome).toEqual(
        revokedWhilePaused
          ? { revokedWhilePaused: true, reply: null, agentReplies: 0 }
          : expect.objectContaining({ revokedWhilePaused: false }),
      );
    } finally {
      release();
      await watcher.close();
      await revoker.close();
    }
  }, 60_000);
});
