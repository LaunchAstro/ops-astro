// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { enrol } from '../commands/fixture.ts';
import { insertActor } from '../identity/fixture.ts';
import {
  access,
  alpha,
  db,
  owner,
  previewOf,
  root,
  seed,
  serverUrl,
  WHOLE,
} from './effective-permissions-world.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await seed();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await db.drop();
});

describe.skipIf(serverUrl === undefined)('inactive actor grants', () => {
  it('an inactive actor grant cannot enter the active actor permission preview', async () => {
    const member = await enrol(db.app, alpha, 'Replacement actor');
    await db.app.withBusiness(alpha, async (tx) => {
      const inactiveActor = await insertActor(tx, member.personId, false);
      return await root(tx, { kind: 'actor', id: inactiveActor }, 'read', WHOLE, owner.actorId);
    });

    expect(
      await executeRead(db.app, alpha, member.presented, { read: 'task.queue' }),
    ).toMatchObject({
      refused: true,
      code: 'SCOPE_NOT_GRANTED',
    });
    const answer = await access();
    expect(previewOf(answer, member.personId)).toStrictEqual([]);
  });
});
