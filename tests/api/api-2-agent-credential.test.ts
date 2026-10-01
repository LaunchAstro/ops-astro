// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2: an agent credential, issued and revoked by a person on their own
// account (Settings ▸ Access), through the real API. This file holds the
// person's half: issue and revoke under `credential:write` (and revoke under
// `access:manage`), the scope never wider than the person's grants and never
// decide, share or manage, an expiry at most 90 days out, the secret shown once
// and kept only as a digest, each act audited, refusals per key, three
// crossings and the canary. Using the credential on the agent route (the next
// call after a revocation, expiry either side, the actor and the person
// recorded, bearer only, the quota) leans on S0-6's bearer scheme and is in
// `api-2-agent-credential-use.test.ts` once that lands.
// The replay, person to person and the revocation race are in
// `api-2-agent-credential-revoke.test.ts`; the world is
// `api-2-agent-credential-world.ts`.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  CANARY,
  clientToken,
  credential,
  credentialCount,
  DAY_MS,
  detailOf,
  digestOf,
  harness,
  issue,
  issueBody,
  openWorld,
  revoke,
  stored,
} from './api-2-agent-credential-world.ts';

if (serverUrl === undefined) {
  console.warn('api/api-2-agent-credential: DATABASE_URL is unset, so nothing below ran.');
}

openWorld();

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 scope narrowed: the scope is the person’s grants narrowed by what they tick, and a wider one is refused', async () => {
    const issued = await issue(issueBody(), harness.world.noah.token);
    expect(issued.status).toBe(200);
    expect(detailOf(issued)['scope']).toEqual([
      { collection: 'task', action: 'read' },
      { collection: 'task', action: 'write' },
    ]);
    const before = await credentialCount(harness.world.alpha);
    // Noah holds no `privacy` key, so a credential for one is wider than he is.
    const wider = await issue(
      issueBody({ scope: [{ collection: 'privacy', action: 'read' }] }),
      harness.world.noah.token,
    );
    expect(wider.status).toBe(403);
    expect(wider.code).toBe('CREDENTIAL_SCOPE_WIDENS');
    expect(await credentialCount(harness.world.alpha)).toBe(before);
  });

  it('API-2 never decide share manage: whatever the person holds, a credential never carries them', async () => {
    const before = await credentialCount(harness.world.alpha);
    for (const action of ['decide', 'share', 'manage'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await issue(issueBody({ scope: [{ collection: 'task', action }] }));
      expect(answer.status, action).toBe(403);
      expect(answer.code, action).toBe('CREDENTIAL_ACTION_EXCLUDED');
    }
    expect(await credentialCount(harness.world.alpha)).toBe(before);
  });
});

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 expiry: at most 90 days from issue, shown on the issue record; later, past or malformed is refused by name', async () => {
    const edge = new Date(Date.now() + 90 * DAY_MS - 60_000).toISOString();
    const ok = await issue(issueBody({ expiresAt: edge }));
    expect(ok.status).toBe(200);
    expect(detailOf(ok)['expiresAt']).toBe(edge);
    const before = await credentialCount(harness.world.alpha);
    for (const expiresAt of [
      new Date(Date.now() + 90 * DAY_MS + 60_000).toISOString(),
      new Date(Date.now() - 60_000).toISOString(),
      'next month',
      undefined,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await issue(issueBody({ expiresAt }));
      expect(answer.status, String(expiresAt)).toBe(422);
      expect(answer.code, String(expiresAt)).toBe('FIELD_VALUE_INVALID');
      expect(answer.body['names'] ?? answer.body, String(expiresAt)).toEqual(
        expect.arrayContaining(['expiresAt']),
      );
    }
    expect(await credentialCount(harness.world.alpha)).toBe(before);
  });

  it('API-2 secret once: the secret is in the issue answer and nowhere else, kept only as its digest', async () => {
    const issued = await issue();
    expect(issued.status).toBe(200);
    const secret = String(detailOf(issued)['credential']);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const text = await stored(harness.world.alpha);
    expect(text).not.toContain(secret);
    expect(text).toContain(digestOf(secret));
    const again = await revoke(detailOf(issued)['credentialId']);
    expect(JSON.stringify(again.body)).not.toContain(secret);
  });
});

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 audited: an issue and a revocation each join the audit chain in their own transaction', async () => {
    const issued = await issue();
    const credentialId = detailOf(issued)['credentialId'];
    expect((await revoke(credentialId)).status).toBe(200);
    const events = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly command: string; readonly outcome: string }>(
          `select command, outcome from public.audit_events
          where command in ('credential.issue', 'credential.revoke')
            and subject_record_id = $1::uuid
          order by seq`,
          [String(credentialId)],
        ),
    );
    expect(events).toEqual([
      { command: 'credential.issue', outcome: 'applied' },
      { command: 'credential.revoke', outcome: 'applied' },
    ]);
  });

  it('API-2 refusal credential:write: a person without the key is refused an issue, and nothing is written', async () => {
    const before = await credentialCount(harness.world.alpha);
    const answer = await issue(issueBody(), harness.world.mia.token);
    expect(answer.status).toBe(403);
    expect(answer.code).toBe('SCOPE_NOT_GRANTED');
    expect(await credentialCount(harness.world.alpha)).toBe(before);
  });

  it('API-2 refusal access:manage: another person’s credential is revoked only under access:manage', async () => {
    const noahs = await issue(issueBody(), harness.world.noah.token);
    const credentialId = detailOf(noahs)['credentialId'];
    const refused = await revoke(credentialId, harness.world.mia.token);
    expect(refused.status).toBe(403);
    expect((await revoke(credentialId)).status, 'Ada holds access:manage').toBe(200);
  });
});

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 isolation: another business, another client and a delegated agent never issue, revoke, read or count one', async () => {
    const planted = await issue(issueBody({ purpose: `alpha only ${CANARY}` }));
    const credentialId = detailOf(planted)['credentialId'];
    const alphaCount = await credentialCount(harness.world.alpha);

    // Another business: Bea is no member of alpha, and bravo has no such credential.
    const across = await revoke(credentialId, harness.world.bea.token, 'alpha');
    expect(across.status).toBe(403);
    expect(across.code).toBe('AUTH_NO_MEMBERSHIP');
    const inBravo = await revoke(credentialId, harness.world.bea.token, 'bravo');
    expect(inBravo.status).toBe(404);
    expect(JSON.stringify([across.body, inBravo.body])).not.toContain(CANARY);

    // Another client in the same business: a share reaches neither command.
    for (const answer of [
      await issue(issueBody(), clientToken),
      await revoke(credentialId, clientToken),
    ]) {
      expect(answer.status).toBe(403);
      expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    }

    // Another person under a live delegation: the agent acting for Ada is
    // refused both on the agent prefix, as every person-only command is.
    for (const path of ['/credential/issue', '/credential/revoke']) {
      // oxlint-disable-next-line no-await-in-loop
      const agent = await call(
        harness.world.api,
        agentPath('alpha', path),
        path.endsWith('issue') ? issueBody() : { operationId: randomUUID(), credentialId },
        { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
      );
      expect(agent.status, path).toBe(403);
      expect(agent.code, path).toBe('DELEGATION_EXCLUDES_OPERATION');
      expect(JSON.stringify(agent.body), path).not.toContain(CANARY);
    }

    expect(await credentialCount(harness.world.alpha)).toBe(alphaCount);
    expect(await credentialCount(harness.world.bravo)).toBe(0);
  });
});

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 canary: a credential’s purpose and secret reach no log, audit row or refusal', async () => {
    const issued = await issue(issueBody({ purpose: CANARY }));
    expect(issued.status, 'the canary credential is issued').toBe(200);
    const secret = String(detailOf(issued)['credential']);
    const refused = await issue(issueBody({ purpose: CANARY, expiresAt: 'never' }));
    expect(JSON.stringify(refused.body)).not.toContain(CANARY);
    const audit = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly row: string }>(
          `select to_jsonb(e)::text as row from public.audit_events e
          where command = 'credential.issue'`,
        ),
    );
    const text = audit.map((one) => one.row).join('\n');
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(secret);
  });
});
