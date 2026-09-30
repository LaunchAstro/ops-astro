// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildCatalogue, reachableBy } from '../../packages/core-wire/src/catalogue.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { seedRecords } from '../acceptance/external-party-records.ts';
import {
  bearer,
  call,
  createWorld,
  enrolExternal,
  personPath,
  serverUrl,
} from '../acceptance/world.ts';

it.skipIf(serverUrl === undefined)(
  'an external party cannot discover a notification setting refused by the API',
  async () => {
    const world = await createWorld('review_external_discovery');
    try {
      const external = await enrolExternal(world);
      const asAdmin = async (recordId: string) =>
        await call(
          world.api,
          personPath('alpha', pathOf('task.read')),
          { recordId },
          bearer(world.ada.token),
        );
      const { shared } = await seedRecords(
        world,
        async (who, name, body) =>
          await call(world.api, personPath('alpha', pathOf(name)), body, bearer(who.token)),
        async (recordId) => {
          const task: unknown = (await asAdmin(recordId)).body['task'];
          if (typeof task !== 'object' || task === null || !('revision' in task)) {
            throw new Error('admin task revision is missing');
          }
          return Number(task.revision);
        },
      );
      const issued = await world.db.app.withBusiness(world.alpha, (tx) =>
        shareRecord(
          tx,
          { personId: world.ada.personId as string, actorId: world.ada.actorId as string },
          { collection: 'task', recordId: shared, personId: external.personId as string },
        ),
      );
      expect(issued.ok).toBe(true);
      const answer = await call(
        world.api,
        personPath('alpha', pathOf('notifications.set_channel')),
        { operationId: randomUUID(), channel: 'email', mode: 'off' },
        bearer(external.token),
      );
      expect(answer.code).toBe('SCOPE_NOT_GRANTED');
      const available = reachableBy(buildCatalogue([]), {
        kind: 'person',
        grants: [{ key: 'task:read', scope: { kind: 'record', id: shared } }],
      }).map((row) => row.command);
      expect(available).not.toContain('notifications.set_channel');
    } finally {
      await world.close();
    }
  },
  120_000,
);
