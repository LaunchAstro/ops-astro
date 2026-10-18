// SPDX-License-Identifier: AGPL-3.0-only
//
// TA-4 presets (ops-astro-roadmap #869): an agent key is for the owner and
// administrators only. Each person here holds a real role's grant list, not a
// hand-built one: the owner the production bootstrap's `OWNER_GRANTS`, and the
// administrator, member and outside party the local seed's `GRANTS_BY_ROLE`.
// A client-portal person holds a share and nothing else, as API-2's client
// does. Each one then asks for an agent key on the real `credential.issue`
// route with their own token: the owner and the administrator get one, and
// every other person is refused with nothing written.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import { GRANTS_BY_ROLE } from '../../scripts/local-seed-roles.ts';
import { OWNER_GRANTS } from '../../scripts/ops/production-bootstrap.ts';
import { enrolCaller, tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, serverUrl, type Answer } from '../acceptance/world.ts';
import { shareWithClient, type Member } from '../commands/fixture.ts';
import { issueBody } from '../api/api-2-agent-credential-world.ts';

if (serverUrl === undefined) {
  console.warn('access/ta-4-real-presets: DATABASE_URL is unset, so nothing below ran.');
}

type Pairs = readonly (readonly [string, Action])[];

/**
 * A key the owner, administrator and member all hold, so the member's refusal
 * is about `credential:write` alone.
 */
const body = (): Readonly<Record<string, unknown>> =>
  issueBody({ scope: [{ collection: 'task', action: 'read' }] });

let harness: Harness;
/** Each person's token, by the role they were given. */
const tokens: Record<string, string> = {};

/** A fresh member of alpha holding `grants`, with the membership role the seed writes. */
async function enrolWith(name: string, roleKey: string, grants: Pairs): Promise<string> {
  const caller = await enrolCaller(harness.world.db, harness.world.alpha, 'alpha', name, {
    membership: true,
    actions: [],
    collections: [],
    extraPairs: grants,
  });
  await harness.world.db.admin.execute(
    'update public.memberships set role_key = $2 where person_id = $1',
    [caller.personId, roleKey],
  );
  return caller.token;
}

/** `credential.issue` on alpha's person prefix, as the holder of `token`. */
async function issue(token: string | undefined): Promise<Answer> {
  return await call(
    harness.world.api,
    personPath('alpha', '/credential/issue'),
    body(),
    bearer(token ?? ''),
  );
}

/** How many agent credentials alpha holds. */
async function credentialCount(): Promise<number> {
  return await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    const rows = await tx.query<{ readonly n: number }>(
      'select count(*)::int as n from public.agent_credentials',
    );
    return rows[0]?.n ?? -1;
  });
}

/** The two people outside alpha's membership: an outside party and a client-portal person. */
async function enrolOthers(): Promise<void> {
  // The outside party: a login and a person, no membership, and the seed's
  // `external` grants, which are none (a business grant without a
  // membership is refused at resolution as a former member).
  const outside = await enrolCaller(harness.world.db, harness.world.alpha, 'alpha', 'outside', {
    membership: false,
    actions: [],
    collections: [],
    extraPairs: GRANTS_BY_ROLE.external,
  });
  tokens['outside party'] = outside.token;
  // The client-portal person: one task shared with them by the owner, nothing else.
  const client = await shareWithClient(
    harness.world.db.app,
    harness.world.alpha,
    harness.world.ada as unknown as Member,
    harness.alphaTask.id,
  );
  tokens['client-portal person'] = await tokenFor(client.presented.subject);
}

describe.skipIf(serverUrl === undefined)('TA-4 presets: who may issue an agent key', () => {
  beforeAll(async () => {
    harness = await createHarness('ta4_presets');
    tokens['owner'] = await enrolWith('owner', 'admin', OWNER_GRANTS);
    tokens['administrator'] = await enrolWith('administrator', 'admin', GRANTS_BY_ROLE.admin);
    tokens['member'] = await enrolWith('member', 'member', GRANTS_BY_ROLE.member);
    await enrolOthers();
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it.each(['owner', 'administrator'])('TA-4 presets: the %s issues an agent key', async (role) => {
    const before = await credentialCount();
    const issued = await issue(tokens[role]);
    expect(issued.status, issued.text).toBe(200);
    expect(issued.body['detail']).toMatchObject({
      scope: [{ collection: 'task', action: 'read' }],
    });
    expect(await credentialCount()).toBe(before + 1);
  });

  it.each([
    ['member', 403, 'SCOPE_NOT_GRANTED'],
    ['client-portal person', 403, 'SCOPE_NOT_GRANTED'],
    ['outside party', 403, 'AUTH_NO_MEMBERSHIP'],
  ] as const)('TA-4 presets: the %s is refused an agent key', async (role, status, code) => {
    const before = await credentialCount();
    const refused = await issue(tokens[role]);
    expect(refused.status, refused.text).toBe(status);
    expect(refused.code, refused.text).toBe(code);
    expect(await credentialCount()).toBe(before);
  });
});
