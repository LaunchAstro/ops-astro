// SPDX-License-Identifier: AGPL-3.0-only
//
// A credential issue asks the issuer's grants for its ticked keys after its
// last wait, the business audit chain key: a grant that runs out while the
// issue waits there mints nothing and releases no secret.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type World } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import {
  credentialsOf,
  detailOf,
  issueAs,
  issueBody,
  issuerIn,
} from './agent-credential-issuer.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a credential issue after its audit chain wait', () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld('sol1475_issue_scope');
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  });

  it('an issue whose ticked grant expires during its audit chain wait mints nothing', async () => {
    const issuer = await issuerIn(world);
    const grantId = issuer.grants['task:write'];
    await world.db.admin.execute(
      "update public.grants set expires_at = clock_timestamp() + interval '3 seconds' where id = $1",
      [grantId],
    );
    const chain = await hold(world.db.appUrl, world.alpha, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [world.alpha]);
    });
    let issuing: ReturnType<typeof issueAs> | undefined;
    try {
      issuing = issueAs(world, issuer, issueBody({ operationId: randomUUID() }));
      await waitingOn(world.db.admin, 'advisory', 'audit_events');
      await expect
        .poll(
          async () => {
            const [row] = await world.db.admin.execute<{ expired: boolean }>(
              'select expires_at <= clock_timestamp() as expired from public.grants where id = $1',
              [grantId],
            );
            return row?.expired;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await chain.letGo();
    }
    const answer = await issuing;
    expect({
      minted: (await credentialsOf(world, issuer)).length,
      releasesSecret: typeof detailOf(answer)['credential'] === 'string',
    }).toEqual({
      minted: 0,
      releasesSecret: false,
    });
  }, 30_000);
});
