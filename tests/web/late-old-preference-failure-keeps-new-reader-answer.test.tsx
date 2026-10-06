// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A preference save the previous business or person made, refused after the
// screen moved on, is that reader's alone (#464): its reread never lands on the
// new reader's answer. The review's proof (F2-FIX3.4), moved unchanged into a
// file named by behaviour; the new reader's client is built by a helper.

import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { mount, settle } from '../surfaces/mount.tsx';

/** The reader the screen moves to: their own stored appearance and tips. */
const nextReader = (business: string): OperationsClient =>
  new OperationsClient({
    origin: '',
    businessKey: business,
    signedIn: true,
    fetch: () =>
      Promise.resolve(
        Response.json({ preferences: { appearance: 'dark', 'tips.enabled': false } }),
      ),
  });

it.each([
  { boundary: 'business to business', business: 'bravo', grant: 'bravo:ada' },
  { boundary: 'person to person', business: 'alpha', grant: 'alpha:ben' },
])(
  '$boundary: a late failed preference save from the previous reader leaves the new reader’s answer',
  async ({ business, grant }) => {
    let refuseOld!: (response: Response) => void;
    const oldSave = new Promise<Response>((resolve) => {
      refuseOld = resolve;
    });
    let oldReads = 0;
    const old = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: (input) => {
        if (String(input).endsWith('/preference/save')) return oldSave;
        oldReads += 1;
        return Promise.resolve(Response.json({ preferences: { appearance: 'light' } }));
      },
    });
    const next = nextReader(business);
    const page = await mount(<YouGroups client={old} grantKey="alpha:ada" storage={null} />);
    const selected = () =>
      page.find('[data-pref="appearance"] button[aria-pressed="true"]')?.textContent;
    try {
      await settle();
      expect(selected()).toBe('Light');
      await page.click('[data-pref="appearance"] button:nth-child(2)');
      await page.render(<YouGroups client={next} grantKey={grant} storage={null} />);
      await settle();
      expect(selected()).toBe('Dark');
      expect(page.text()).toContain('Guided tips are off');
      await act(async () => {
        refuseOld(
          Response.json(
            { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] },
            { status: 403 },
          ),
        );
        await oldSave;
      });
      await settle();
      expect(oldReads).toBeGreaterThanOrEqual(1);
      expect(
        { appearance: selected(), tipsOff: page.text().includes('Guided tips are off') },
        'The old reader reread replaced the current reader answer with a hidden old-owner value',
      ).toEqual({ appearance: 'Dark', tipsOff: true });
    } finally {
      await page.unmount();
      delete document.documentElement.dataset['themePreference'];
      delete document.documentElement.dataset['themeFade'];
    }
  },
);
