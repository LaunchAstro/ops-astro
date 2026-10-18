// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's agent credential (API-2, owner check U18, #1818): a
// session holding `credential:write` makes one for itself with task access
// only, sees its secret once, and revokes it by its id. The secret reaches no
// outcome line, no storage and no console, and leaves the page when hidden or
// when the business changes. A retry after a lost answer replays the first
// issue's operation id and body. The world is `access-screen-world.tsx`'s.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessScreen } from '../../apps/web/src/screens/Access.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import {
  ADA,
  MANAGE_ONLY,
  access,
  choose,
  heldAnswer,
  json,
  live,
  open,
  refusal,
  server,
  unmountAll,
} from './access-screen-world.tsx';

afterEach(unmountAll);
afterEach(() => {
  vi.restoreAllMocks();
});

const ISSUER = [
  ...MANAGE_ONLY,
  { collection: 'credential', action: 'write' },
  { collection: 'task', action: 'read' },
  { collection: 'task', action: 'write' },
];
const SECRET = 'oaac_PLANTED-agent-credential-canary-7f3a9e';
const ISSUED = {
  recordId: 'cred-1',
  revision: 1,
  detail: {
    credentialId: 'cred-1',
    agentActorId: 'a-cred-1',
    scope: [
      { collection: 'task', action: 'read' },
      { collection: 'task', action: 'write' },
    ],
    expiresAt: '2026-10-25T00:00:00.000Z',
    credential: SECRET,
  },
};
const DAY_MS = 24 * 60 * 60 * 1000;

/** The world's server, its commands answered in turn by `answers` (the last repeats). */
function world(answers: readonly (() => Response | Promise<Response>)[], grants = ISSUER) {
  let sent = 0;
  const write = () => {
    const answer = answers[Math.min(sent, answers.length - 1)];
    sent += 1;
    return answer === undefined ? json({ recordId: 'r', revision: 1 }) : answer();
  };
  return server([json(access([ADA]))], write, grants);
}

const issues = (api: ReturnType<typeof server>) =>
  api.commands().filter((call) => call.url.endsWith('/credential/issue'));

async function make(view: Awaited<ReturnType<typeof open>>, purpose: string): Promise<void> {
  await view.type('[data-access="credential"] [data-field="purpose"] input', purpose);
  await view.click('[data-access="credential"] [data-act="make"] button');
  await settle();
  await settle();
}

describe('agent credential on Settings ▸ Access', () => {
  it('makes an agent credential with task read and task write only, for the purpose and life chosen', async () => {
    const api = world([() => json(ISSUED)]);
    const view = await open(api.fetch);
    await choose(view, 'life', '7 days');
    const before = Date.now();
    await make(view, 'Add tasks from the CLI');
    const [call] = issues(api);
    expect(call?.url).toBe('/api/b/alpha/credential/issue');
    expect(call?.body['scope']).toEqual([
      { collection: 'task', action: 'read' },
      { collection: 'task', action: 'write' },
    ]);
    expect(call?.body['purpose']).toBe('Add tasks from the CLI');
    const expires = Date.parse(String(call?.body['expiresAt']));
    expect(expires).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);
    expect(view.find('[data-access="credential"]')?.textContent).toContain('task:write');
  });

  it('offers no credential control to a session without credential:write', async () => {
    const api = world([() => json(ISSUED)], MANAGE_ONLY);
    const view = await open(api.fetch);
    expect(view.find('[data-access="credential"]')).toBeNull();
    expect(view.text()).not.toContain('Make agent credential');
  });

  it('draws the secret once, in no outcome line, storage or console, and Hide takes it off the page', async () => {
    const said = vi.spyOn(console, 'log');
    const warned = vi.spyOn(console, 'warn');
    const erred = vi.spyOn(console, 'error');
    const api = world([() => json(ISSUED)]);
    const view = await open(api.fetch);
    await make(view, 'Add tasks from the CLI');
    const field = view.find('[data-credential-secret]') as HTMLInputElement | null;
    expect(field?.value).toBe(SECRET);
    expect(field?.readOnly).toBe(true);
    expect(view.find('[data-access-outcome]')?.textContent).not.toContain(SECRET);
    const stored = Object.keys(window.sessionStorage).map((key) =>
      window.sessionStorage.getItem(key),
    );
    expect(stored.join(' ')).not.toContain(SECRET);
    const logged = [...said.mock.calls, ...warned.mock.calls, ...erred.mock.calls].flat();
    expect(logged.map(String).join(' ')).not.toContain(SECRET);
    await view.click('[data-act="hide-secret"] button');
    expect(view.host.innerHTML).not.toContain(SECRET);
    expect(view.find('[data-credential="cred-1"]')?.textContent).toContain(
      'Add tasks from the CLI',
    );
  });

  it('revokes the credential just made by its id, then says it is revoked', async () => {
    const api = world([() => json(ISSUED), () => json({ recordId: 'cred-1', revision: 2 })]);
    const view = await open(api.fetch);
    await make(view, 'Add tasks from the CLI');
    await view.click('[data-credential="cred-1"] [data-act="revoke"] button');
    await settle();
    await settle();
    const revokes = api.commands().filter((call) => call.url.endsWith('/credential/revoke'));
    expect(revokes).toEqual([
      {
        url: '/api/b/alpha/credential/revoke',
        body: expect.objectContaining({ credentialId: 'cred-1' }) as unknown,
      },
    ]);
    expect(view.find('[data-credential="cred-1"]')?.textContent).toContain('Revoked');
    expect(view.find('[data-credential="cred-1"] [data-act="revoke"]')).toBeNull();
    expect(view.host.innerHTML).not.toContain(SECRET);
  });

  it('draws a refused issue in the server words and shows no credential', async () => {
    const api = world([() => refusal('CREDENTIAL_SCOPE_WIDENS', 403)]);
    const view = await open(api.fetch);
    await make(view, 'Add tasks from the CLI');
    expect(view.find('[data-access-section="credential"] [role="alert"]')?.textContent).toContain(
      'CREDENTIAL_SCOPE_WIDENS',
    );
    expect(view.find('[data-credential-secret]')).toBeNull();
    expect(view.all('[data-credential]')).toEqual([]);
  });

  it('retries after no answer with the same operation id and body, so the server replays the first issue', async () => {
    const api = world([() => new Response('', { status: 503 }), () => json(ISSUED)]);
    const view = await open(api.fetch);
    await make(view, 'Add tasks from the CLI');
    expect(view.find('[data-credential-secret]')).toBeNull();
    await view.click('[data-access="credential"] [data-act="make"] button');
    await settle();
    await settle();
    const [first, again] = issues(api);
    expect(again?.body).toEqual(first?.body);
    expect((view.find('[data-credential-secret]') as HTMLInputElement | null)?.value).toBe(SECRET);
  });

  it('a second credential after an answer is a new operation', async () => {
    const api = world([() => json(ISSUED), () => json({ ...ISSUED, recordId: 'cred-2' })]);
    const view = await open(api.fetch);
    await make(view, 'Add tasks from the CLI');
    await make(view, 'Add tasks from the CLI');
    const [first, second] = issues(api);
    expect(second?.body['operationId']).not.toBe(first?.body['operationId']);
  });

  it('a business switch drops the secret, the made credentials and an answer still out for the other business', async () => {
    const held = heldAnswer();
    const api = world([() => json(ISSUED), () => held.promise]);
    const alpha = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: api.fetch,
    });
    const beta = new OperationsClient({
      origin: '',
      businessKey: 'beta',
      signedIn: true,
      fetch: api.fetch,
    });
    const view = await mount(<AccessScreen client={alpha} grantKey="alpha:p-ada" />);
    live.push(view);
    await settle();
    await settle();
    await make(view, 'Add tasks from the CLI');
    expect(view.host.innerHTML).toContain(SECRET);
    await view.type('[data-access="credential"] [data-field="purpose"] input', 'A second one');
    await view.click('[data-access="credential"] [data-act="make"] button');
    await view.render(<AccessScreen client={beta} grantKey="beta:p-ada" />);
    await settle();
    expect(view.host.innerHTML).not.toContain(SECRET);
    expect(view.all('[data-credential]')).toEqual([]);
    held.resolve(json({ ...ISSUED, recordId: 'cred-2' }));
    await settle();
    await settle();
    expect(view.host.innerHTML).not.toContain(SECRET);
    expect(view.all('[data-credential]')).toEqual([]);
  });
});
