// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2: the agent credential after its issue, through the real API: the
// issuer's replay gets the same secret while it is live and none once
// revoked, another person's credential is not found without `access:manage`,
// a revocation applies once and deactivates the agent actor, and a second
// transaction waits on the row lock. The world is
// `api-2-agent-credential-world.ts`.

import { describe, expect, it } from 'vitest';
import {
  lockAgentCredential,
  revokeAgentCredential,
} from '../../packages/core-records/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  detailOf,
  harness,
  issue,
  issueBody,
  openWorld,
  revoke,
  stored,
} from './api-2-agent-credential-world.ts';

openWorld();

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 replay: the issuer’s retry of one issue gets the same secret while it is live, and none once revoked', async () => {
    const body = issueBody();
    const first = await issue(body);
    const again = await issue(body);
    expect(again.status).toBe(200);
    const secret = String(detailOf(first)['credential']);
    expect(detailOf(again)['credential']).toBe(secret);
    expect(detailOf(again)['credentialId']).toBe(detailOf(first)['credentialId']);
    expect(await stored(harness.world.alpha)).not.toContain(secret);
    expect((await revoke(detailOf(first)['credentialId'])).status).toBe(200);
    const spent = await issue(body);
    expect(spent.status).toBe(200);
    expect(detailOf(spent)['credential']).toBeNull();
    expect(JSON.stringify(spent.body)).not.toContain(secret);
  });

  it('API-2 person to person: without access:manage another person’s credential is not found, and stays live', async () => {
    const adas = await issue();
    const credentialId = detailOf(adas)['credentialId'];
    const refused = await revoke(credentialId, harness.world.noah.token);
    expect(refused.status).toBe(404);
    expect(refused.code).toBe('NOT_FOUND');
    const live = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly revoked: boolean }>(
          'select revoked_at is not null as revoked from public.agent_credentials where id = $1',
          [String(credentialId)],
        ),
    );
    expect(live).toEqual([{ revoked: false }]);
  });
});

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 revoked once: two revocations apply once, and the agent actor is deactivated', async () => {
    const credentialId = detailOf(await issue())['credentialId'];
    const answers = await Promise.all([revoke(credentialId), revoke(credentialId)]);
    expect(answers.map((answer) => answer.status).toSorted()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.status === 409)?.code).toBe(
      'CREDENTIAL_ALREADY_REVOKED',
    );
    const agent = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly active: boolean }>(
          `select a.active from public.actors a
             join public.agent_credentials c on c.agent_actor_id = a.id
            where c.id = $1`,
          [String(credentialId)],
        ),
    );
    expect(agent).toEqual([{ active: false }]);
  });
});

/** A promise and the call that settles it. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  const settle: (() => void)[] = [];
  const promise = new Promise<void>((resolve) => {
    settle.push(resolve);
  });
  return { promise, open: () => settle[0]?.() };
}

/** One revocation in its own transaction; `hold` keeps it open after the update. */
const revokeInTransaction = async (
  database: Database,
  credentialId: string,
  hold?: Promise<void>,
  locked?: () => void,
) =>
  await database.withBusiness(harness.world.alpha, async (tx) => {
    const held = await lockAgentCredential(tx, credentialId);
    if (held === undefined) return 'not-found';
    const refusal = await revokeAgentCredential(tx, held, harness.world.ada.actorId as string);
    locked?.();
    await hold;
    return refusal ?? 'revoked';
  });

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 revocation race: a second transaction waits on the row lock and finds it revoked', async () => {
    const credentialId = String(detailOf(await issue())['credentialId']);
    // Two connections, so the two transactions truly overlap: the first holds
    // its revocation open while the second asks for the same row.
    const wide = connect(harness.world.db.appUrl, { source: 'runtime', max: 2 });
    const hold = latch();
    const updated = latch();
    const first = revokeInTransaction(wide, credentialId, hold.promise, updated.open);
    await updated.promise;
    const second = revokeInTransaction(wide, credentialId);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    hold.open();
    const outcomes = await Promise.allSettled([first, second]).finally(
      async () => await wide.close(),
    );
    expect(outcomes).toEqual([
      { status: 'fulfilled', value: 'revoked' },
      { status: 'fulfilled', value: 'already-revoked' },
    ]);
  });
});
