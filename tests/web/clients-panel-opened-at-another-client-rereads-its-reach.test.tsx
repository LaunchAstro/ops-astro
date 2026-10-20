// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// CS-7.29: the Clients panel opened at one client and then at another (a
// second inbox group door, same person and session) asks `client.list` again,
// so a client whose grant was withdrawn in between is said in a sentence and
// never named from the earlier answer, not even while the new read is out.

import { afterEach, describe, expect, it } from 'vitest';
import { ClientsScreen } from '../../apps/web/src/screens/Clients.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { json } from './mp-2-1-support.tsx';

const SUMMIT = { clientId: 'c-summit', name: 'Summit Allied' };
const REVOKED = { clientId: 'c-revoked', name: 'Revoked Proof Client' };

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

/** A server whose first `client.list` reaches both clients, and whose later ones wait to be answered. */
function withdrawing() {
  const reads: string[] = [];
  const later: ((response: Response) => void)[] = [];
  const client = new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (url) => {
      const path = new URL(String(url)).pathname;
      if (!path.endsWith('/client/list'))
        return Promise.resolve(new Response('{}', { status: 404 }));
      reads.push(path);
      if (reads.length === 1)
        return Promise.resolve(json({ ok: true, clients: [SUMMIT, REVOKED] }));
      return new Promise<Response>((resolve) => {
        later.push(resolve);
      });
    },
  });
  return { client, reads, later };
}

const opened = (page: Mounted): string => page.find('.clbook__opened')?.textContent ?? '';

describe('CS-7.29 Clients panel opened at another client', () => {
  it('rereads client.list and never names a client the new answer leaves out', async () => {
    const { client, reads, later } = withdrawing();
    const at = (clientId: string) => (
      <ClientsScreen client={client} grantKey="alpha:ada" at={clientId} />
    );
    const page = await mount(at(SUMMIT.clientId));
    live.push(page);
    await settle();
    expect(page.find('.clbook__opened .clbook__name')?.textContent).toBe('Summit Allied');

    // Everything drawn from here on, the render before the reread starts included.
    const drawn: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) drawn.push(node.textContent ?? '');
    });
    watch.observe(page.host, { childList: true, subtree: true, characterData: true });
    await page.render(at(REVOKED.clientId));
    await settle();
    expect(reads).toHaveLength(2);
    // While the new read is out, the earlier answer names nothing at the mark.
    expect(opened(page)).not.toContain(REVOKED.name);
    expect(page.find('.clbook__opened [href]')).toBeNull();

    later.shift()?.(json({ ok: true, clients: [SUMMIT] }));
    await settle();
    await settle();
    expect(opened(page)).toBe('The client you opened is not in your book.');
    expect(page.text()).not.toContain(REVOKED.name);
    watch.disconnect();
    expect(drawn.filter((each) => each.includes(REVOKED.name))).toEqual([]);
  });
});
