// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildCatalogue, reachableBy } from '../../packages/core-wire/src/catalogue.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { clearingWorld, ok } from './inbox-clearing-world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'discovery of the callers own inbox',
  () => {
    const world = clearingWorld('inboxdiscovery');
    it('lists the self-scoped inbox commands that a task reader can call without an inbox or preference grant', async () => {
      const task = await world.task('A task assigned to the reader');
      ok(
        await world.call('task.assign', {
          recordId: task.id,
          expectedRevision: task.rev,
          fields: { assignee: world.writer.personId },
        }),
      );
      const read = ok(await world.call('inbox.read', {}, world.writerToken));
      const entries = read.body['inbox'];
      if (!Array.isArray(entries) || entries.length !== 1)
        throw new Error('one assignment is owed');
      ok(await world.call('inbox.count', {}, world.writerToken));
      ok(await world.call('inbox.seen', { itemId: entries[0].id }, world.writerToken));
      const discovered = reachableBy(buildCatalogue([]), {
        kind: 'person',
        member: true,
        grants: ['read', 'write', 'comment'].map((action) => ({
          key: `task:${action}`,
          scope: { kind: 'business', id: null },
        })),
      }).map((row) => row.command);
      expect(discovered).toEqual(
        expect.arrayContaining(['inbox.read', 'inbox.count', 'inbox.seen']),
      );
    });
  },
);
