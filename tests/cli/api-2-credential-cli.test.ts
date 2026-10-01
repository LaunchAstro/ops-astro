// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2 on the command line: `credential.issue` and `credential.revoke` sent
// through the CLI client (`apps/cli/client.ts`) and straight to the API, as the
// same caller with the same body. Each pair must answer alike: the same status
// and code, the same refusal body word for word, and on success the same
// record apart from the values minted per call (the id, the secret, the
// operation). The catalogue's parity check (API-1) holds the two to one
// profile; this proves the answers, one test per command.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bearer, call, personPath, serverUrl } from '../acceptance/world.ts';
import {
  credentialCount,
  DAY_MS,
  detailOf,
  harness,
  issue,
  issueBody,
  openWorld,
} from '../api/api-2-agent-credential-world.ts';
import {
  both as bothOn,
  cliAs as cliOn,
  refusedAlike,
  refusedSame,
  sameRecord as sameOn,
  type Pair,
  type Route,
} from './cli-parity.ts';

if (serverUrl === undefined) {
  console.warn('cli/api-2-credential-cli: DATABASE_URL is unset, so nothing below ran.');
}

openWorld();

type Verb = 'credential.issue' | 'credential.revoke';

const cliAs = (token: string, businessKey: string, entry: 'person' | 'agent') =>
  cliOn(harness.world.api, token, businessKey, entry);

const both = async (
  verb: Verb,
  body: Readonly<Record<string, unknown>>,
  token: string,
  route?: Route,
): Promise<Pair> => await bothOn(harness.world.api, verb, body, token, route);

const secretOf = (answer: unknown): unknown =>
  ((answer as { detail?: Record<string, unknown> }).detail ?? {})['credential'];

const idOf = async (token: string): Promise<unknown> =>
  detailOf(await issue(issueBody(), token))['credentialId'];

const live = async (businessId: string, id: unknown): Promise<boolean> =>
  await harness.world.db.app.withBusiness(businessId, async (tx) => {
    const rows = await tx.query<{ readonly live: boolean }>(
      'select revoked_at is null as live from public.agent_credentials where id = $1',
      [id],
    );
    return rows[0]?.live ?? false;
  });

/** A success is the same record on both, bar the values minted per call. */
const MINTED = new Set(['recordId', 'credentialId', 'credential', 'agentActorId', 'operationId']);
const sameRecord = (pair: Pair): void => sameOn(pair, MINTED);

describe.skipIf(serverUrl === undefined)('API-2 on the command line', () => {
  it('API-2 CLI credential.issue: the command line gives the same result and the same refusals as the API', async () => {
    const { world } = harness;
    const body = issueBody({ purpose: 'the command line and the API alike' });
    const issued = await both('credential.issue', body, world.ada.token);
    sameRecord(issued);
    expect(typeof secretOf(issued.cli.body), 'the secret is shown once, on each surface').toBe(
      'string',
    );
    expect(typeof secretOf(issued.api.body)).toBe('string');

    const before = await credentialCount(world.alpha);
    // Without `credential:write`.
    refusedAlike(
      await both('credential.issue', issueBody(), world.mia.token),
      403,
      'SCOPE_NOT_GRANTED',
    );
    // Wider than the person's grants, and a key no credential ever carries.
    const wider = issueBody({ scope: [{ collection: 'task', action: 'decide' }] });
    refusedSame(await both('credential.issue', wider, world.noah.token));
    // Past the 90 days.
    const late = issueBody({ expiresAt: new Date(Date.now() + 91 * DAY_MS).toISOString() });
    refusedSame(await both('credential.issue', late, world.ada.token));
    // Another business: Ada is no member of bravo.
    refusedSame(
      await both('credential.issue', issueBody(), world.ada.token, { businessKey: 'bravo' }),
    );
    // An agent, on the agent route: the command is a person's alone.
    refusedSame(await both('credential.issue', issueBody(), world.agent.token, { entry: 'agent' }));
    expect(await credentialCount(world.alpha), 'no refusal wrote a credential').toBe(before);
    expect(await credentialCount(world.bravo)).toBe(0);
  });
});

describe.skipIf(serverUrl === undefined)('API-2 on the command line', () => {
  it('API-2 CLI credential.revoke: the command line gives the same result and the same refusals as the API', async () => {
    const { world } = harness;
    // Two of Noah's credentials, one revoked through each surface by Noah.
    const first = await idOf(world.noah.token);
    const second = await idOf(world.noah.token);
    const byCli = await cliAs(world.noah.token, 'alpha', 'person').run('credential.revoke', {
      operationId: `api2-cli-${randomUUID()}`,
      credentialId: first,
    });
    const byApi = await call(
      world.api,
      personPath('alpha', '/credential/revoke'),
      { operationId: `api2-api-${randomUUID()}`, credentialId: second },
      bearer(world.noah.token),
    );
    sameRecord({ cli: byCli, api: { status: byApi.status, body: byApi.body } });

    // Mia holds neither `credential:write` nor `access:manage`.
    const third = await idOf(world.noah.token);
    refusedAlike(
      await both('credential.revoke', { credentialId: third }, world.mia.token),
      403,
      'SCOPE_NOT_GRANTED',
    );
    // One already revoked, one never issued.
    refusedSame(await both('credential.revoke', { credentialId: first }, world.noah.token));
    refusedSame(await both('credential.revoke', { credentialId: randomUUID() }, world.noah.token));
    // Bea's, from another business, by id through alpha and by bravo's prefix.
    const beas = detailOf(await issue(issueBody(), world.bea.token, 'bravo'))['credentialId'];
    refusedSame(await both('credential.revoke', { credentialId: beas }, world.ada.token));
    refusedSame(
      await both('credential.revoke', { credentialId: beas }, world.ada.token, {
        businessKey: 'bravo',
      }),
    );
    // An agent, on the agent route.
    refusedSame(
      await both('credential.revoke', { credentialId: third }, world.agent.token, {
        entry: 'agent',
      }),
    );

    // Nothing refused changed a row: the third is live, Bea's is live.
    expect(await live(world.alpha, third)).toBe(true);
    expect(await live(world.bravo, beas)).toBe(true);
    expect(await live(world.alpha, first)).toBe(false);
    expect(await live(world.alpha, second)).toBe(false);
  });
});
