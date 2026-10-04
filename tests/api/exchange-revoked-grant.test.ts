// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #422, OW-031.3 (Refs #422; OW-031.4, the broker's dispatch, is
// CAT-CUSTODY-2's under ORCH84 422SPLIT): the conversation exchange reads a
// kept reply only while the caller still holds the conversation grant
// conversation.read asks. The case is the review's proof, renamed for what it
// proves and otherwise as written.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';
import { grantTo } from '../commands/fixture.ts';

describe('the conversation exchange and the conversation grant', () => {
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
        (await w.as(w.owner, 'conversation.read', { conversationId: asked.conversationId })).status,
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
});
