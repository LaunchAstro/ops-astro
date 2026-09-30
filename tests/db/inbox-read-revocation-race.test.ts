// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { raiseInboxItem, readInboxItems } from '../../packages/core-records/src/index.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { connect, type TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import { createTask } from '../tasks/fixture.ts';

const noop = (): void => {};

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = noop;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

/* eslint-disable max-lines-per-function -- one grant, pause, revocation and read schedule */
describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'inbox read across a grant change',
  () => {
    it('a grant revoked before the item query withholds the item in that read', async () => {
      const db = await createFreshDatabase({ part: 'inb1_revoke_race' });
      try {
        const business = await insertBusiness(db.app, 'race');
        const { personId, grantId, itemId } = await db.app.withBusiness(business, async (tx) => {
          const spine = await installTaskSpine(tx);
          const person = await insertPerson(tx, 'Reader');
          const actor = await insertActor(tx, person);
          const task = await createTask(tx, spine, { title: 'Revoked task', parentId: null });
          const issued = await issueGrant(tx, [], {
            subject: { kind: 'person', id: person },
            scope: { kind: 'record', id: task },
            collection: 'task',
            action: 'read',
            parentGrantId: null,
            grantedByActorId: actor,
          });
          if (!issued.ok) throw new Error(issued.refusal.code);
          const item = await raiseInboxItem(tx, {
            recipientPersonId: person,
            subjectRecordId: task,
            reason: 'mention',
            fact: { kind: 'record', id: randomUUID() },
          });
          return { personId: person, grantId: issued.value, itemId: item };
        });

        const { promise: atItemQuery, release: enterItemQuery } = deferred();
        const { promise: mayReadItems, release: releaseItemQuery } = deferred();
        let held = false;
        const reading = db.app.withBusiness(business, async (tx) => {
          const paused: TenantQuery = {
            businessId: tx.businessId,
            async query<Row>(
              statement: string,
              parameters?: readonly unknown[],
            ): Promise<readonly Row[]> {
              if (!held && statement.startsWith('with shown as')) {
                held = true;
                enterItemQuery();
                await mayReadItems;
              }
              return await tx.query<Row>(statement, parameters);
            },
          };
          return await readInboxItems(paused, personId);
        });
        const writer = connect(db.appUrl);
        try {
          await atItemQuery;
          await writer.withBusiness(business, async (tx) => await revokeGrant(tx, grantId));
        } finally {
          releaseItemQuery();
          await writer.close();
        }
        const entries = await reading;
        const fresh = await db.app.withBusiness(
          business,
          async (tx) => await readInboxItems(tx, personId),
        );
        expect(fresh.find((entry) => entry.id === itemId)?.access).toBe('withheld');
        expect(entries.find((entry) => entry.id === itemId)?.access).toBe('withheld');
      } finally {
        await db.drop();
      }
    });
  },
);
