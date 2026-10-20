// SPDX-License-Identifier: AGPL-3.0-only
//
// An issue replay judges its credential's expiry after its last wait, the
// business audit chain key: a credential that runs out while the replay waits
// there releases no secret.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type World } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { detailOf, issueAs, issueBody, issuerIn } from './agent-credential-issuer.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('an issue replay after its audit chain wait', () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld('sol1475_expiry');
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  });

  it('an issue replay releases no secret when its credential expires during the audit chain wait', async () => {
    const issuer = await issuerIn(world);
    const body = issueBody({
      operationId: randomUUID(),
      expiresAt: new Date(Date.now() + 4000).toISOString(),
    });
    const first = await issueAs(world, issuer, body);
    expect(typeof detailOf(first)['credential']).toBe('string');
    const credentialId = detailOf(first)['credentialId'];
    const chain = await hold(world.db.appUrl, world.alpha, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [world.alpha]);
    });
    let replay: ReturnType<typeof issueAs> | undefined;
    try {
      replay = issueAs(world, issuer, body);
      await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
      await expect
        .poll(
          async () => {
            const [row] = await world.db.admin.execute<{ expired: boolean }>(
              'select expires_at <= clock_timestamp() as expired from public.agent_credentials where id = $1',
              [credentialId],
            );
            return row?.expired;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await chain.letGo();
    }
    const answer = await replay;
    expect(typeof detailOf(answer)['credential'] === 'string').toBe(false);
  }, 30_000);
});
