// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's quick-add for a reader who may not file tasks (THERMO-2
// continuation, lead item c). Since U112 the quick-add is a door into the one
// kept draft, not a create form of its own, so a reader without the draft
// gets it closed: the box and its button are disabled and carry no door, and
// nothing is sent.

import { describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { mount, settle } from './mount.tsx';

function server() {
  const writes: string[] = [];
  const fetch = ((url: string | URL) => {
    const at = String(url);
    // The inbox the board screen mounts (INB-1g), answered empty.
    if (at.endsWith('/inbox/read')) return Response.json({ ok: true, inbox: [] });
    if (at.endsWith('/inbox/count')) return Response.json({ ok: true, owed: 0 });
    if (at.endsWith('/task/create')) writes.push(at);
    return Promise.resolve(Response.json({ ok: true, tasks: [] }));
  }) as typeof globalThis.fetch;
  return { fetch, writes };
}

describe('the create form, refused on authority', () => {
  it('closes rather than asking again', async () => {
    const api = server();
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: api.fetch,
    });
    const view = await mount(<Projects client={client} grantKey="alpha:mia" navigate={() => {}} />);
    await settle();

    const box = view.find('#create-title') as HTMLInputElement;
    const button = view.find('.projects__create button[type="submit"]') as HTMLButtonElement;
    expect(box.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.dataset['newTask']).toBeUndefined();

    await view.click('.projects__create button[type="submit"]');
    await settle();
    expect(api.writes).toHaveLength(0);

    await view.unmount();
  });
});
