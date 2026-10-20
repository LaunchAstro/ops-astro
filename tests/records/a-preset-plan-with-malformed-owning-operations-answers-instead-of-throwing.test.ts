// SPDX-License-Identifier: AGPL-3.0-only
//
// A preset plan's field whose owning operations are not a list is answered by
// the read, never thrown out of it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { createWorld, type World } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { issuerIn, type Issuer } from '../authority/agent-credential-issuer.ts';
import { grantTo } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a preset plan with malformed owning operations', () => {
  let world: World;
  let issuer: Issuer;
  beforeAll(async () => {
    world = await createWorld('sol1475_preset');
    issuer = await issuerIn(world);
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, issuer, 'manage');
    });
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  });

  it('a preset plan whose field names its owning operations as an object answers instead of throwing', async () => {
    await expect(
      executeRead(world.db.app, world.alpha, issuer.presented, {
        read: 'preset.plan',
        recordTypeKey: 'task',
        presetKey: 'agency',
        fields: [
          {
            key: 'malformed_owner',
            label: 'Malformed owner',
            valueType: 'text',
            writeMode: 'generic',
            owningOperations: {},
          },
        ],
      } as never),
    ).resolves.toBeTypeOf('object');
  });
});
