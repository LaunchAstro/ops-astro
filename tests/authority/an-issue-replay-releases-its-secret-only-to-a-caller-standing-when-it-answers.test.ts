// SPDX-License-Identifier: AGPL-3.0-only
//
// The issuer's replay of `credential.issue` derives the secret again, which
// is a read of the credential row, the clock and the issuer's grants, then a
// `replayed` audit event and the secret in the answer. It waits on the
// business's access lock and then on the credential row, and what it read
// before either wait may have changed by the time it answers.
//
// Two connections: another connection revokes the credential while the
// replay waits on the row, revokes a ticked key while it waits on the access
// lock, or signs its session out while it waits on the access lock. A crash:
// the `replayed` event raises. A retry: the same operation sent once more
// after that crash.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  lockAgentCredential,
  revokeAgentCredential,
} from '../../packages/core-records/src/authority/agent-credentials.ts';
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
import { hold, waitingOn } from '../support/lock-waits.ts';
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
  if (serverUrl !== undefined) world = await createWorld('credreplayrace');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await world.close();
});

/** An issuer on a session of their own, with one credential issued: its body and first answer. */
async function issued(): Promise<{
  readonly issuer: Issuer;
  readonly body: Readonly<Record<string, unknown>>;
  readonly first: Readonly<Record<string, unknown>>;
}> {
  const member = await issuerIn(world);
  const issuer = { ...member, presented: { ...member.presented, sessionId: randomUUID() } };
  const body = issueBody();
  const answer = await issueAs(world, issuer, body);
  expect(isCommandRefusal(answer), JSON.stringify(answer)).toBe(false);
  const first = detailOf(answer);
  expect(typeof first['credential']).toBe('string');
  return { issuer, body, first };
}

/**
 * The replay on its own connection while a fixture transaction holds the
 * access lock; once the replay waits on it, `meanwhile` runs inside the
 * fixture, which then commits.
 */
async function replayBehindAccessLock(
  replay: (database: Database) => Promise<unknown>,
  meanwhile: (tx: TenantQuery) => Promise<void>,
): Promise<unknown> {
  const fixture = connect(world.db.appUrl);
  const replaying = connect(world.db.appUrl);
  try {
    let answer: Promise<unknown> | undefined;
    await fixture.withBusiness(world.alpha, async (tx) => {
      await advisoryLock(tx, `access:${tx.businessId}`);
      answer = replay(replaying);
      answer.catch(() => null);
      await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
      await meanwhile(tx);
    });
    return await answer;
  } finally {
    await Promise.all([fixture.close(), replaying.close()]);
  }
}

const auditedFor = async (operationId: unknown): Promise<readonly string[]> =>
  (
    await world.db.admin.execute<{ readonly outcome: string }>(
      `select outcome from public.audit_events where operation_id = $1 order by seq`,
      [String(operationId)],
    )
  ).map((row) => row.outcome);

it('a replay waiting on the credential row while another connection revokes it returns no secret', async () => {
  const { issuer, body, first } = await issued();
  const revoking = await hold(world.db.appUrl, world.alpha, async (tx) => {
    const held = await lockAgentCredential(tx, String(first['credentialId']));
    if (held === undefined) throw new Error('the issued credential is not there');
    await revokeAgentCredential(tx, held, issuer.actorId);
  });
  const replaying = connect(world.db.appUrl);
  try {
    const replay = issueAs(world, issuer, body, replaying);
    replay.catch(() => null);
    try {
      await waitingOn(world.db.admin, 'transactionid', 'from public.agent_credentials');
    } finally {
      await revoking.letGo();
    }
    const answer = await replay;
    expect({ refused: isCommandRefusal(answer), secret: detailOf(answer)['credential'] }).toEqual({
      refused: false,
      secret: null,
    });
  } finally {
    await replaying.close();
  }
}, 60_000);

it('a replay whose ticked key is revoked while it waits on the access lock returns no secret', async () => {
  const { issuer, body, first } = await issued();
  const answer = await replayBehindAccessLock(
    async (database) => await issueAs(world, issuer, body, database),
    async (tx) => {
      await revokeGrant(tx, issuer.grants['task:write'] ?? '');
    },
  );
  expect(JSON.stringify(answer)).not.toContain(String(first['credential']));
  expect(codeOf(answer)).toBe('CREDENTIAL_SCOPE_WIDENS');
}, 60_000);

it('a replay whose session signs out while it waits on the access lock returns no secret', async () => {
  const { issuer, body, first } = await issued();
  const answer = await replayBehindAccessLock(
    async (database) => await issueAs(world, issuer, body, database),
    async () => {
      await world.db.app.withBusiness(world.alpha, async (tx) => {
        await endProviderSession(tx, String(issuer.presented.sessionId));
      });
    },
  );
  expect({
    secretReturned: JSON.stringify(answer).includes(String(first['credential'])),
    code: codeOf(answer),
    // The door refuses the ended session once the replay has answered.
    sentNow: codeOf(await issueAs(world, issuer, body)),
  }).toEqual({
    secretReturned: false,
    code: 'AUTH_SESSION_EXPIRED',
    sentNow: 'AUTH_SESSION_EXPIRED',
  });
}, 60_000);

it('a replay whose replayed event raises returns no secret and records its failed attempt', async () => {
  const { issuer, body } = await issued();
  const dying = failingStatements(world.db.app, insertsInto('audit_events'), 1);
  await expect(issueAs(world, issuer, body, dying)).rejects.toBeInstanceOf(StatementFailed);
  expect({
    audited: await auditedFor(body['operationId']),
    minted: (await credentialsOf(world, issuer)).length,
  }).toEqual({ audited: ['applied', 'failed'], minted: 1 });
}, 60_000);

it('a replay sent again after its replayed event raised returns the one secret', async () => {
  const { issuer, body, first } = await issued();
  const dying = failingStatements(world.db.app, insertsInto('audit_events'), 1);
  await expect(issueAs(world, issuer, body, dying)).rejects.toBeInstanceOf(StatementFailed);
  const again = await issueAs(world, issuer, body);
  expect({
    secret: detailOf(again)['credential'],
    audited: await auditedFor(body['operationId']),
    minted: (await credentialsOf(world, issuer)).length,
  }).toEqual({
    secret: first['credential'],
    audited: ['applied', 'failed', 'replayed'],
    minted: 1,
  });
}, 60_000);
