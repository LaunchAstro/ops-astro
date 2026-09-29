// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { raiseInboxItem, readInboxItems } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo } from './fixture.ts';
import { clearingWorld, decideBody, ok } from './inbox-clearing-world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('Sol INB-1c isolation', () => {
  const w = clearingWorld('solinb1c');

  it('Sol proof, criterion 3: deciding client A does not clear a client B item', async () => {
    const clientA = await w.proposed('client A decision', randomUUID());
    const clientBId = randomUUID();
    const clientB = await w.proposed('client B task', clientBId);
    const clientBReader = await enrol(w.fixture.db.app, w.fixture.business, 'Client B reader');
    const clientBItem = await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, clientBReader, 'read', { kind: 'party', id: clientBId });
      return await raiseInboxItem(tx, {
        recipientPersonId: clientBReader.personId,
        subjectRecordId: clientB.task.id,
        reason: 'decision',
        fact: { kind: 'gate', id: clientA.gateId },
      });
    });

    const before = await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await readInboxItems(tx, clientBReader.personId),
    );
    expect(before.find((item) => item.id === clientBItem)).toMatchObject({
      access: 'readable',
      workState: 'open',
      subjectRecordId: clientB.task.id,
    });

    ok(await w.call('task.decide', decideBody(clientA), w.reviewerToken));

    const [row] = await w.fixture.db.admin.execute<{ work_state: string }>(
      'select work_state from public.inbox_items where id = $1',
      [clientBItem],
    );
    expect(row?.work_state).toBe('open');
  });
});
