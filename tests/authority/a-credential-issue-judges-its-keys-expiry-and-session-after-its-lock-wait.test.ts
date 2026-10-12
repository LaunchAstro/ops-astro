// SPDX-License-Identifier: AGPL-3.0-only
//
// `credential.issue` reads, then mints: it judges the expiry, waits for the
// business's access lock, walks each ticked key against the issuer's grants,
// inserts the agent actor and the credential row, and has its session asked
// once more under the ending keys before it commits. Each read stands only if
// it is still true when the row commits.
//
// Two connections: a fixture transaction takes the access lock, the issue is
// seen waiting on it, and the fixture then commits a competing change (a
// ticked key revoked, the clock run past the asked expiry, the session signed
// out). A crash: the credential insert raises, so the transaction dies between
// the reads and the write. A retry: the same operation sent again after that
// crash, and again after a lost response.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';
import {
  advisoryLock,
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { failingStatements, insertsInto, StatementFailed } from '../support/failing-statements.ts';
import { waitingOn } from '../support/lock-waits.ts';
import {
  codeOf,
  credentialsOf,
  detailOf,
  issueAs,
  issueBody,
  issuerIn,
  type Issuer,
} from './agent-credential-issuer.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let world: World;

beforeAll(async () => {
  if (serverUrl !== undefined) world = await createWorld('credissuerace');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await world.close();
});

/** An issuer signed in on a session of their own. */
const issuerOnSession = async (): Promise<Issuer> => {
  const issuer = await issuerIn(world);
  return { ...issuer, presented: { ...issuer.presented, sessionId: randomUUID() } };
};

/**
 * Runs `issue` on its own connection while a fixture transaction holds the
 * access lock; once the issue waits on it, `meanwhile` runs inside the
 * fixture, which then commits and lets the issue go on.
 */
async function issueBehindAccessLock(
  issue: (database: Database) => Promise<unknown>,
  meanwhile: (tx: TenantQuery) => Promise<void>,
): Promise<unknown> {
  const fixture = connect(world.db.appUrl);
  const issuing = connect(world.db.appUrl);
  try {
    let answer: Promise<unknown> | undefined;
    await fixture.withBusiness(world.alpha, async (tx) => {
      await advisoryLock(tx, `access:${tx.businessId}`);
      answer = issue(issuing);
      // Keep a rejection for the await below, not an unhandled one.
      answer.catch(() => null);
      await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
      await meanwhile(tx);
    });
    return await answer;
  } finally {
    await Promise.all([fixture.close(), issuing.close()]);
  }
}

/** The issue's register rows and audit outcomes, in chain order. */
async function trailOf(issuer: Issuer, operationId: unknown): Promise<unknown> {
  const [trail] = await world.db.admin.execute(
    `select (select count(*)::int from public.operations
              where operation_id = $1 and actor_id = $2) as registered,
            (select coalesce(array_agg(outcome order by seq), '{}') from public.audit_events
              where operation_id = $1) as audited`,
    [String(operationId), issuer.actorId],
  );
  return trail;
}

/** The business's agent actors: an issue that mints nothing leaves this unchanged. */
const agentActors = async (): Promise<number> => {
  const [row] = await world.db.admin.execute<{ readonly agents: number }>(
    `select count(*)::int as agents from public.actors where business_id = $1 and kind = 'agent'`,
    [world.alpha],
  );
  return row?.agents ?? 0;
};

it('an issue whose ticked key is revoked while it waits on the access lock is refused and mints nothing', async () => {
  const issuer = await issuerOnSession();
  const answer = await issueBehindAccessLock(
    async (database) => await issueAs(world, issuer, issueBody(), database),
    async (tx) => {
      await revokeGrant(tx, issuer.grants['task:write'] ?? '');
    },
  );
  expect({ code: codeOf(answer), minted: await credentialsOf(world, issuer) }).toEqual({
    code: 'CREDENTIAL_SCOPE_WIDENS',
    minted: [],
  });
}, 60_000);

it('an issue that waits on the access lock past the expiry it asked for mints no credential already expired', async () => {
  const issuer = await issuerOnSession();
  const [clock] = await world.db.admin.execute<{ readonly at: Date }>(
    'select clock_timestamp() as at',
  );
  const expiresAt = new Date((clock?.at.getTime() ?? 0) + 2_000).toISOString();
  const answer = await issueBehindAccessLock(
    async (database) => await issueAs(world, issuer, issueBody({ expiresAt }), database),
    async () => {
      await delay(3_000);
    },
  );
  expect({
    code: codeOf(answer),
    minted: (await credentialsOf(world, issuer)).map((row) => row.expires_at.toISOString()),
  }).toEqual({ code: 'FIELD_VALUE_INVALID', minted: [] });
}, 60_000);

it('an issue whose session signs out while it waits on the access lock is refused and mints nothing', async () => {
  const issuer = await issuerOnSession();
  const agentsBefore = await agentActors();
  const answer = await issueBehindAccessLock(
    async (database) => await issueAs(world, issuer, issueBody(), database),
    async () => {
      await world.db.app.withBusiness(world.alpha, async (tx) => {
        await endProviderSession(tx, String(issuer.presented.sessionId));
      });
    },
  );
  expect({
    code: codeOf(answer),
    minted: await credentialsOf(world, issuer),
    agents: await agentActors(),
  }).toEqual({ code: 'AUTH_SESSION_EXPIRED', minted: [], agents: agentsBefore });
}, 60_000);

it('an issue whose credential insert raises mints nothing and records its failed attempt', async () => {
  const issuer = await issuerOnSession();
  const body = issueBody();
  const agentsBefore = await agentActors();
  const dying = failingStatements(world.db.app, insertsInto('agent_credentials'), 1);
  await expect(issueAs(world, issuer, body, dying)).rejects.toBeInstanceOf(StatementFailed);
  expect({
    minted: await credentialsOf(world, issuer),
    agents: await agentActors(),
    trail: await trailOf(issuer, body['operationId']),
  }).toEqual({ minted: [], agents: agentsBefore, trail: { registered: 0, audited: ['failed'] } });
}, 60_000);

it('an issue sent again after its insert raised mints one credential and replays its secret', async () => {
  const issuer = await issuerOnSession();
  const body = issueBody();
  const dying = failingStatements(world.db.app, insertsInto('agent_credentials'), 1);
  await expect(issueAs(world, issuer, body, dying)).rejects.toBeInstanceOf(StatementFailed);
  const first = await issueAs(world, issuer, body);
  expect(isCommandRefusal(first), JSON.stringify(first)).toBe(false);
  // The same operation once more, as after a lost response.
  const again = await issueAs(world, issuer, body);
  expect({
    secret: detailOf(again)['credential'],
    minted: (await credentialsOf(world, issuer)).length,
    trail: await trailOf(issuer, body['operationId']),
  }).toEqual({
    secret: detailOf(first)['credential'],
    minted: 1,
    trail: { registered: 1, audited: ['failed', 'applied', 'replayed'] },
  });
}, 60_000);
