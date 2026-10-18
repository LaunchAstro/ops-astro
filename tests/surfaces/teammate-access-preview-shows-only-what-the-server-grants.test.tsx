// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's preview of a teammate's access (C32, owner check U14,
// #1819): Preview access, beside Give access, draws what the chosen teammate
// may do now and which clients that reaches, from `access.read`'s own answer
// and nothing else. It follows each reread, names a client only from the
// read's client records, sends nothing, and goes when the teammate leaves the
// list or the business changes. The world is `access-screen-world.tsx`'s.

import { afterEach, describe, expect, it } from 'vitest';
import { AccessScreen } from '../../apps/web/src/screens/Access.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import {
  ACME,
  ADA,
  BOLT,
  MIA,
  MIA_ON_ACME,
  access,
  choose,
  json,
  live,
  open,
  refusal,
  server,
  unmountAll,
} from './access-screen-world.tsx';

afterEach(unmountAll);

const HIDDEN = 'c-not-listed-4b7d';
const preview = (view: Awaited<ReturnType<typeof open>>): string =>
  view.find('[data-access="preview"]')?.textContent ?? '';

async function previewMia(view: Awaited<ReturnType<typeof open>>): Promise<void> {
  await choose(view, 'holder', MIA.name);
  await view.click('[data-access="give"] [data-act="preview"] button');
}

describe('preview of a teammate on Settings ▸ Access', () => {
  it('after a teammate is given one client, their preview names that client only', async () => {
    const api = server([json(access([ADA, MIA])), json(access([ADA, MIA_ON_ACME]))]);
    const view = await open(api.fetch);
    await previewMia(view);
    expect(preview(view)).toContain(MIA.name);
    expect(preview(view)).toContain('No permission');
    await choose(view, 'key', 'task:read');
    await choose(view, 'scope', ACME.name);
    await view.click('[data-access="give"] button[type="submit"]');
    await settle();
    await settle();
    // The preview is the server's reread, not the choice in the form.
    expect(preview(view)).toContain(ACME.name);
    expect(preview(view)).toContain('task:read');
    expect(preview(view)).not.toContain(BOLT.name);
    expect(preview(view)).not.toContain('whole business');
  });

  it('a refused grant leaves the preview as the server last answered', async () => {
    const api = server([json(access([ADA, MIA]))], () => refusal('SCOPE_NOT_GRANTED', 403));
    const view = await open(api.fetch);
    await previewMia(view);
    await choose(view, 'key', 'task:read');
    await choose(view, 'scope', ACME.name);
    await view.click('[data-access="give"] button[type="submit"]');
    await settle();
    expect(preview(view)).toContain('No permission');
    expect(preview(view)).not.toContain(ACME.name);
  });

  it('names a client the read does not list as that, never by its id', async () => {
    const hidden = {
      ...MIA,
      permissions: [{ collection: 'task', action: 'read', scope: { kind: 'party', id: HIDDEN } }],
    };
    const api = server([json(access([ADA, hidden]))]);
    const view = await open(api.fetch);
    await previewMia(view);
    expect(preview(view)).toContain('a client not listed here');
    expect(view.host.innerHTML).not.toContain(HIDDEN);
  });

  it('sends nothing and asks no other read', async () => {
    const api = server([json(access([ADA, MIA_ON_ACME]))]);
    const view = await open(api.fetch);
    const before = api.calls.length;
    await previewMia(view);
    await settle();
    expect(api.calls.length).toBe(before);
    expect(preview(view)).toContain(ACME.name);
  });
});

describe('preview of a teammate on Settings ▸ Access: when it goes', () => {
  it('goes when the teammate leaves the list', async () => {
    const api = server([json(access([ADA, MIA_ON_ACME])), json(access([ADA]))]);
    const view = await open(api.fetch);
    await previewMia(view);
    await view.click(`[data-end="${MIA.personId}"] button`);
    await view.click('[data-confirm="end-access"] [data-act="end"] button');
    await settle();
    await settle();
    expect(view.find('[data-access="preview"]')).toBeNull();
  });

  it('goes when the business changes, even for a person of the same id there', async () => {
    const api = server([json(access([ADA, MIA_ON_ACME]))]);
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
    await previewMia(view);
    expect(preview(view)).toContain(ACME.name);
    await view.render(<AccessScreen client={beta} grantKey="beta:p-ada" />);
    await settle();
    await settle();
    expect(view.find('[data-access="preview"]')).toBeNull();
  });
});
