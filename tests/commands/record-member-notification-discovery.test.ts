// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildCatalogue, reachableBy } from '../../packages/core-wire/src/catalogue.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { authorised, createApiFixture, post, tokenFor } from '../api/fixture.ts';
import { enrol, grantTo } from './fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a member with only a record grant discovers their own notification setting',
  async () => {
    const fixture = await createApiFixture('review_record_member');
    try {
      const api = fixture.compose();
      const adminToken = await tokenFor(fixture.member.presented.subject);
      const made = await post(
        api,
        `/api/b/alpha${pathOf('task.create')}`,
        { operationId: randomUUID(), fields: { title: 'Record grant control' } },
        authorised(adminToken),
      );
      expect(made.status).toBe(200);
      const recordId = made.body['recordId'];
      if (typeof recordId !== 'string') throw new Error('task record was not created');

      const member = await enrol(fixture.db.app, fixture.business, 'record-only-member');
      await fixture.db.app.withBusiness(fixture.business, async (tx) =>
        await grantTo(tx, member, 'read', { kind: 'record', id: recordId }),
      );
      const memberToken = await tokenFor(member.presented.subject);
      const setting = await post(
        api,
        `/api/b/alpha${pathOf('notifications.set_channel')}`,
        { operationId: randomUUID(), channel: 'in_app', mode: 'on' },
        authorised(memberToken),
      );
      expect(setting.status).toBe(200);

      const discovered = reachableBy(buildCatalogue([]), {
        kind: 'person',
        grants: [{ key: 'task:read', scope: { kind: 'record', id: recordId } }],
        member: true,
      }).map((row) => row.command);
      expect(discovered).toContain('notifications.set_channel');
    } finally {
      await fixture.drop();
    }
  },
  120_000,
);
