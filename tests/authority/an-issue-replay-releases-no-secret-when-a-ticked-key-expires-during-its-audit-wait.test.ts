// SPDX-License-Identifier: AGPL-3.0-only
//
// An issue replay walks the issuer's ticked keys after its last wait, the
// business audit key: a covering grant that expires while the replay waits
// there releases no secret.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWorld, type World } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { codeOf, detailOf, issueAs, issueBody, issuerIn } from './agent-credential-issuer.ts';

let world: World;

beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) throw new Error('This proof requires Postgres.');
  world = await createWorld('sol1475_replay');
}, 180_000);

afterAll(async () => {
  await world?.close();
});

it('an issue replay releases no secret when a ticked key expires during its audit lock wait', async () => {
  const issuer = await issuerIn(world);
  const body = issueBody({ operationId: randomUUID() });
  const first = await issueAs(world, issuer, body);
  expect(typeof detailOf(first)['credential']).toBe('string');
  const grantId = issuer.grants['task:write'];
  if (grantId === undefined) throw new Error('No write grant');
  await world.db.admin.execute(
    `update public.grants set expires_at = clock_timestamp() + interval '3 seconds' where id = $1`,
    [grantId],
  );
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
  const answer = await replay;
  expect({
    code: codeOf(answer),
    releasesSecret: typeof detailOf(answer)['credential'] === 'string',
  }).toEqual({ code: 'CREDENTIAL_SCOPE_WIDENS', releasesSecret: false });
}, 30_000);
