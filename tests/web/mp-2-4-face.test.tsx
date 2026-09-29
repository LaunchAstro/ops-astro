// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-4, the face switch and the client-face chrome (R17). Inside a client
// the strip flips between the workspace and a labelled "view as client"
// preview of the portal; the client face is teal, tagged "Client portal", with
// no timer, presence or dock; copy speaks to the client in the second person
// and channel links print as plain text. `MP-2-4 isolation` makes the three
// crossings: another business, another client in the same business, and
// another person under a live delegation.

// oxlint-disable no-await-in-loop

import { describe, expect, it, vi } from 'vitest';
import { ChannelLink, FaceProvider, Voice, useFace } from '../../apps/web/src/face.tsx';
import type { ClientAccess } from '../../apps/web/src/manifest.ts';
import { mount } from '../surfaces/mount.tsx';
import { filled, open } from './mp-2-1-support.tsx';

const faceButton = (label: 'Agency' | 'Client'): string =>
  `.appbar .facesw button[data-face="${label.toLowerCase()}"]`;

describe('MP-2-4 the switch shows only inside a client workspace or portal', () => {
  it('draws the switch on client and portal pages and nowhere in the Hub', async () => {
    for (const [address, shown] of [
      ['/clients/acme-dental/workbench/', true],
      ['/portal/acme-dental/account/', true],
      ['/dashboard/', false],
      ['/projects/', false],
      ['/clients/', false],
    ] as const) {
      const { view } = await open(address);
      expect(view.find('.appbar .facesw') !== null, address).toBe(shown);
      await view.unmount();
    }
  });
});

describe('MP-2-4 Client from /clients/:client/* goes to /portal/:client/', () => {
  it('goes to the portal home from any workspace page', async () => {
    const { view, seen } = await open('/clients/acme-dental/library/voice/');
    expect(view.find(faceButton('Agency'))?.getAttribute('aria-pressed')).toBe('true');
    await view.click(faceButton('Client'));
    expect(seen.at(-1)).toBe('/portal/acme-dental/');
    expect(view.find(faceButton('Client'))?.getAttribute('aria-pressed')).toBe('true');
    await view.unmount();
  });
});

describe('MP-2-4 Agency from the portal goes to /clients/:client/', () => {
  it("goes to the client's workspace overview", async () => {
    const { view, seen } = await open('/portal/acme-dental/projects/');
    await view.click(faceButton('Agency'));
    expect(seen.at(-1)).toBe('/clients/acme-dental/');
    await view.unmount();
  });
});

describe('MP-2-4 pressing the face already on does nothing', () => {
  it('stays put on either face', async () => {
    for (const [address, label] of [
      ['/portal/acme-dental/', 'Client'],
      ['/clients/acme-dental/', 'Agency'],
    ] as const) {
      const { view, seen } = await open(address);
      const before = [...seen];
      await view.click(faceButton(label));
      expect(seen, address).toEqual(before);
      await view.unmount();
    }
  });
});

describe('MP-2-4 the client face has the teal strip and "Client portal" tag, no timer, no presence and no dock', () => {
  it('draws the client-face chrome on the portal', async () => {
    const { view } = await open('/portal/acme-dental/');
    expect(view.find('.shell')?.getAttribute('data-face')).toBe('client');
    expect(view.find('.appbar')?.getAttribute('data-face')).toBe('client');
    expect(view.find('.appbar .clienthdr__tag')?.textContent).toBe('Client portal');
    expect(view.find('.appbar .appbar__timer')).toBeNull();
    expect(view.all('.appbar .viewers')).toHaveLength(0);
    expect(view.all('.dock__tab')).toHaveLength(0);
    await view.unmount();
  });
});

describe('MP-2-4 CS-2.5 a labelled "view as client" preview, client writes disabled', () => {
  it('labels the portal face as a preview for the agency member', async () => {
    const { view } = await open('/portal/acme-dental/');
    expect(view.find('.appbar .appbar__preview')?.textContent).toBe('Viewing as the client');
    await view.unmount();
  });

  it('disables client writes on the client face and allows none of them', async () => {
    let seenFace: ReturnType<typeof useFace> | null = null;
    const Probe = (): null => {
      seenFace = useFace();
      return null;
    };
    const view = await mount(
      <FaceProvider face="client">
        <Probe />
      </FaceProvider>,
    );
    expect(seenFace).toEqual({ face: 'client', preview: true, writes: false });
    await view.unmount();
  });

  it('reads nothing a client login would not be served, on the client face', async () => {
    const asked: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Promise<Response>(() => {});
    }) as unknown as typeof globalThis.fetch;
    for (const address of [
      '/portal/acme-dental/',
      '/portal/acme-dental/projects/',
      '/portal/acme-dental/account/',
    ]) {
      const { view } = await open(address, { fetch });
      await view.unmount();
    }
    // An agency member's `task.read` answers the internal detail, never the
    // shared projection a client login gets, so the preview asks for nothing
    // until MP-11-1 serves the portal from the shared projection server-side.
    // The one read is the person menu's own name (C23), which a client login is
    // served too (`tests/commands/c23-session-end.test.ts`).
    expect(asked.filter((url) => !url.endsWith('/session/person'))).toEqual([]);
  });
});

describe('MP-2-4 copy swaps between third and second person', () => {
  it('speaks of the client on the agency face and to the client on the client face', async () => {
    for (const [face, said] of [
      ['agency', 'Their plan'],
      ['client', 'Your plan'],
    ] as const) {
      const view = await mount(
        <FaceProvider face={face}>
          <Voice agency="Their plan" client="Your plan" />
        </FaceProvider>,
      );
      expect(view.text()).toBe(said);
      await view.unmount();
    }
  });
});

describe('MP-2-4 channel links render as plain text on the client face', () => {
  it('links on the agency face and prints plain text on the client face', async () => {
    for (const [face, linked] of [
      ['agency', true],
      ['client', false],
    ] as const) {
      const view = await mount(
        <FaceProvider face={face}>
          <ChannelLink href="https://ads.example.invalid/campaign/1">Campaign one</ChannelLink>
        </FaceProvider>,
      );
      expect(view.all('a[href]').length > 0, face).toBe(linked);
      expect(view.text(), face).toBe('Campaign one');
      await view.unmount();
    }
  });
});

describe('MP-2-4 the client-face chrome is the client-face variant of the app strip', () => {
  it('uses the one strip component with its client-face variant', async () => {
    const { view } = await open('/portal/acme-dental/');
    expect(view.all('.appbar')).toHaveLength(1);
    expect(view.find('.appbar')?.getAttribute('data-face')).toBe('client');
    await view.unmount();
  });
});

// Two businesses, two clients in business alpha, one grant each, and a person
// acting under a live delegation from another: each crossing is refused with
// nothing of the other side in the switch, the strip, the rail or the tabs.
const ALPHA_TWO: Readonly<Record<string, readonly string[]>> = {
  alpha: ['acme-dental'],
  bravo: ['zenith-plumbing'],
  // Kim acts for alpha's Mia under a live delegation; the grant is Kim's own,
  // and it narrows to the one client Mia delegated.
  'alpha-delegate': ['acme-dental'],
};
const access: ClientAccess = (business, client) => ALPHA_TWO[business]?.includes(client) ?? false;

const CROSSINGS = [
  { who: 'alpha', to: 'zenith-plumbing', what: 'another business' },
  { who: 'alpha', to: 'harbour-physio', what: 'another client in the same business' },
  { who: 'alpha-delegate', to: 'harbour-physio', what: 'another person under a live delegation' },
] as const;

describe('MP-2-4 isolation', () => {
  it.each(CROSSINGS)(
    'refuses $what with no switch and nothing of theirs drawn',
    async ({ who, to }) => {
      for (const namespace of ['clients', 'portal'] as const) {
        const address = filled(`/${namespace}/:client/`, to);
        const { view } = await open(address, { businessKey: who, clientAccess: access });
        expect(view.find('[data-outcome="denied"]'), address).not.toBeNull();
        expect(view.find('.appbar .facesw'), address).toBeNull();
        expect(view.find('.appbar .clienthdr'), address).toBeNull();
        expect(view.text().toLowerCase(), address).not.toContain(to.split('-')[0]);
        expect(
          view.all('a[href]').some((a) => a.getAttribute('href')?.includes(to)),
          address,
        ).toBe(false);
        await view.unmount();
      }
    },
  );

  it('keeps the switch on the granted client for the delegate, pointing only at that client', async () => {
    const { view, seen } = await open('/clients/acme-dental/', {
      businessKey: 'alpha-delegate',
      clientAccess: access,
    });
    await view.click(faceButton('Client'));
    expect(seen.at(-1)).toBe('/portal/acme-dental/');
    await view.unmount();
  });
});
