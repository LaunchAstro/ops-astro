// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #422, OW-031.3 (Refs #422; OW-031.4, the broker's dispatch, is
// CAT-CUSTODY-2's under ORCH84 422SPLIT): the conversation exchange reads a
// kept reply only while the caller still holds the conversation grant
// conversation.read asks. The first case is the review's proof, renamed for
// what it proves and otherwise as written. The second revokes the grant while
// the model answers: the reply is kept only under the conversation's row lock,
// and the grant is asked again there.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant, type TenantQuery } from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, both cases on it
describe.skipIf(serverUrl === undefined)(
  'the conversation exchange and the conversation grant',
  () => {
    let w: ConversationWorld;
    let c: Controls;
    let model: LocalModel;
    beforeAll(async () => {
      c = await createControls('exchange_grant');
      w = await conversationWorld(c);
      model = await localModel();
    }, 180_000);
    afterAll(async () => {
      await model?.close();
      await w?.drop();
    });

    it('a revoked conversation grant prevents the exchange from reading a kept reply', async () => {
      const opened = await w.as(w.owner, 'conversation.start', {
        body: 'Revocation also covers replay',
      });
      const asked = {
        conversationId: String(detail(opened)['conversationId']),
        messageId: String(detail(opened)['messageId']),
      };
      expect(
        await model.exchange(w.fixture.db.app, w.fixture.business, w.owner.presented, asked),
      ).toMatchObject({ answered: true });
      const grants = await w.fixture.db.app.withBusiness(
        w.fixture.business,
        async (tx) =>
          await tx.query<{ id: string }>(
            "select id from grants where subject_id = $1 and collection = 'conversation' and action = 'write' and revoked_at is null",
            [w.owner.personId],
          ),
      );
      expect(grants.length).toBeGreaterThan(0);
      await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
        // eslint-disable-next-line no-await-in-loop -- grant changes share one transaction
        for (const grant of grants) await revokeGrant(tx, grant.id);
      });
      try {
        expect(
          (await w.as(w.owner, 'conversation.read', { conversationId: asked.conversationId }))
            .status,
        ).toBe(403);
        const reply = await model.exchange(
          w.fixture.db.app,
          w.fixture.business,
          w.owner.presented,
          asked,
        );
        expect(reply).toBeNull();
      } finally {
        await w.fixture.db.app.withBusiness(
          w.fixture.business,
          async (tx) => await grantTo(tx, w.owner, 'write', undefined, false, 'conversation'),
        );
      }
    });

    it('a conversation grant revoked while the model answers keeps no reply', async () => {
      const opened = await w.as(w.owner, 'conversation.start', { body: 'Revoked mid-answer' });
      const asked = {
        conversationId: String(detail(opened)['conversationId']),
        messageId: String(detail(opened)['messageId']),
      };
      const sent = model.provider.seen.length;
      const second = connect(w.fixture.db.appUrl, { source: 'runtime' });
      let replying: ReturnType<LocalModel['exchange']> | undefined;
      try {
        // The revocation holds the conversation's row lock and commits only
        // once the exchange, past the model, waits on that lock to keep the reply.
        await second.withBusiness(w.fixture.business, async (tx) => {
          await tx.query(
            'select id from conversations where business_id = $1 and id = $2 for update',
            [tx.businessId, asked.conversationId],
          );
          await revokeConversationWrite(tx);
          replying = model.exchange(w.fixture.db.app, w.fixture.business, w.owner.presented, asked);
          await someoneWaits();
        });
        expect(await replying).toBeNull();
        expect(model.provider.seen.length).toBe(sent + 1);
        expect(
          await w.count(
            "select count(*) as n from public.conversation_messages where conversation_id = $1 and role = 'agent'",
            [asked.conversationId],
          ),
        ).toBe(0);
      } finally {
        await second.close();
        await w.fixture.db.app.withBusiness(
          w.fixture.business,
          async (tx) => await grantTo(tx, w.owner, 'write', undefined, false, 'conversation'),
        );
      }
    });

    async function revokeConversationWrite(tx: TenantQuery): Promise<void> {
      const grants = await tx.query<{ id: string }>(
        "select id from grants where subject_id = $1 and collection = 'conversation' and action = 'write' and revoked_at is null",
        [w.owner.personId],
      );
      expect(grants.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-await-in-loop -- grant changes share one transaction
      for (const grant of grants) await revokeGrant(tx, grant.id);
    }

    /** Waits until a backend in this database waits on a lock. */
    async function someoneWaits(): Promise<void> {
      for (let tries = 0; tries < 200; tries += 1) {
        // eslint-disable-next-line no-await-in-loop -- polling the server
        const n = await w.count(
          `select count(*) as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
          [],
        );
        if (n >= 1) return;
        // eslint-disable-next-line no-await-in-loop
        await sleep(25);
      }
      throw new Error('the exchange never waited on the conversation lock');
    }
  },
);
