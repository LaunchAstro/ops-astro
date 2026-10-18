// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's agent credential revocation (API-2, #1818): a revoke
// whose answer is lost is retried with the same operation id, so the server
// replays the revocation it already made, and an answer that the credential
// is revoked already (`CREDENTIAL_ALREADY_REVOKED`) shows it revoked and drops
// the secret. A person switch drops the secret and any answer still out. The
// server is modelled as `credential-write.ts` and the register answer it: the
// same operation replays its first success, a new one on a revoked credential
// is a 409. The world is `access-screen-world.tsx`'s.

import { afterEach, describe, expect, it } from 'vitest';
import { AccessScreen } from '../../apps/web/src/screens/Access.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import {
  ADA,
  MANAGE_ONLY,
  access,
  heldAnswer,
  json,
  live,
  open,
  refusal,
  server,
  unmountAll,
} from './access-screen-world.tsx';

afterEach(unmountAll);

const ISSUER = [
  ...MANAGE_ONLY,
  { collection: 'credential', action: 'write' },
  { collection: 'task', action: 'read' },
  { collection: 'task', action: 'write' },
];
const SECRET = 'oaac_PLANTED-revoke-retry-canary-31c8';
const ISSUED = {
  recordId: 'cred-r',
  revision: 1,
  detail: { credentialId: 'cred-r', expiresAt: '2026-11-01T00:00:00.000Z', credential: SECRET },
};
const REVOKED = json({ recordId: 'cred-r', revision: 2 });

async function make(view: Awaited<ReturnType<typeof open>>): Promise<void> {
  await view.type('[data-access="credential"] [data-field="purpose"] input', 'An agent of mine');
  await view.click('[data-access="credential"] [data-act="make"] button');
  await settle();
  await settle();
}

async function revoke(view: Awaited<ReturnType<typeof open>>): Promise<void> {
  await view.click('[data-credential="cred-r"] [data-act="revoke"] button');
  await settle();
  await settle();
}

const shownRevoked = (view: Awaited<ReturnType<typeof open>>): void => {
  expect(view.find('[data-credential="cred-r"]')?.textContent).toContain('Revoked');
  expect(view.find('[data-credential="cred-r"] [data-act="revoke"]')).toBeNull();
  expect(view.find('[data-credential-secret]')).toBeNull();
  expect(view.host.innerHTML).not.toContain(SECRET);
};

describe('agent credential revocation on Settings ▸ Access', () => {
  it('a revoke retried after a lost answer reuses its operation id and shows the credential revoked', async () => {
    let first: unknown;
    let api: ReturnType<typeof server> | undefined;
    api = server(
      [json(access([ADA]))],
      () => {
        const call = api?.commands().at(-1);
        if (call?.url.endsWith('/credential/issue') === true) return json(ISSUED);
        // The revocation commits, and its answer is lost.
        if (first === undefined) {
          first = call?.body['operationId'];
          return new Response('', { status: 503 });
        }
        return call?.body['operationId'] === first
          ? REVOKED
          : refusal('CREDENTIAL_ALREADY_REVOKED', 409);
      },
      ISSUER,
    );
    const view = await open(api.fetch);
    await make(view);
    await revoke(view);
    expect(view.find('[data-credential="cred-r"] [data-act="revoke"]')).not.toBeNull();
    await revoke(view);
    const revokes = api.commands().filter((call) => call.url.endsWith('/credential/revoke'));
    expect(revokes.map((call) => call.body['operationId'])).toEqual([first, first]);
    shownRevoked(view);
  });

  it('an answer that it is revoked already shows the credential revoked and drops the secret', async () => {
    let api: ReturnType<typeof server> | undefined;
    api = server(
      [json(access([ADA]))],
      () =>
        api?.commands().at(-1)?.url.endsWith('/credential/issue') === true
          ? json(ISSUED)
          : refusal('CREDENTIAL_ALREADY_REVOKED', 409),
      ISSUER,
    );
    const view = await open(api.fetch);
    await make(view);
    await revoke(view);
    expect(view.find('[data-access-section="credential"] [role="alert"]')?.textContent).toContain(
      'CREDENTIAL_ALREADY_REVOKED',
    );
    shownRevoked(view);
  });

  it('a revoke refused for another reason keeps Revoke and the secret', async () => {
    let api: ReturnType<typeof server> | undefined;
    api = server(
      [json(access([ADA]))],
      () =>
        api?.commands().at(-1)?.url.endsWith('/credential/issue') === true
          ? json(ISSUED)
          : refusal('NOT_FOUND', 404),
      ISSUER,
    );
    const view = await open(api.fetch);
    await make(view);
    await revoke(view);
    expect(view.find('[data-credential="cred-r"] [data-act="revoke"]')).not.toBeNull();
    expect(view.find('[data-credential="cred-r"]')?.textContent).not.toContain('Revoked');
  });
});

describe('agent credential on Settings ▸ Access: a person switch', () => {
  it('a person switch drops the secret and the earlier person’s answer still out', async () => {
    const held = heldAnswer();
    let writes = 0;
    const api = server(
      [json(access([ADA]))],
      () => {
        writes += 1;
        return writes === 1 ? json(ISSUED) : held.promise;
      },
      ISSUER,
    );
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: api.fetch,
    });
    const view = await mount(<AccessScreen client={client} grantKey="alpha:p-ada" />);
    live.push(view);
    await settle();
    await settle();
    await make(view);
    expect((view.find('[data-credential-secret]') as HTMLInputElement | null)?.value).toBe(SECRET);
    await make(view);
    await view.render(<AccessScreen client={client} grantKey="alpha:p-noah" />);
    await settle();
    expect(view.find('[data-credential-secret]')).toBeNull();
    expect(view.all('[data-credential]')).toEqual([]);
    held.resolve(json(ISSUED));
    await settle();
    await settle();
    expect(view.find('[data-credential-secret]')).toBeNull();
    expect(view.all('[data-credential]')).toEqual([]);
  });
});
