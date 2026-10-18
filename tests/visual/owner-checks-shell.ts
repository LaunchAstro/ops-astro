// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a step clicks, then looks, in order: the film shows one after the next */
//
// The owner checks of the shell and dock units (U06, U07, U08 with U12, U10),
// as the owner checks issue (ops-astro#1750) words them.
import {
  BEAT,
  LAPTOP,
  PHONE,
  expectVisible,
  go,
  notHere,
  red,
  type Check,
} from './owner-checks-steps.ts';

export const SHELL: readonly Check[] = [
  {
    unit: 'U06',
    issue: 676,
    title: 'Rail, drawer, tab row, page header and reserved addresses',
    width: PHONE,
    start: '/projects/',
    steps: [
      [
        'The menu button slides the navigation in, and it closes',
        async (page) => {
          await page.getByRole('button', { name: 'Open the menu' }).click();
          const drawer = page.getByRole('dialog', { name: 'Sections' });
          await expectVisible('the Sections navigation', () => drawer);
          await page.waitForTimeout(BEAT);
          await drawer.getByRole('button', { name: 'Close the menu' }).click();
          const closed = await drawer
            .waitFor({ state: 'hidden', timeout: 4000 })
            .then(() => true)
            .catch(() => false);
          if (!closed) throw red('the navigation did not close');
        },
      ],
      [
        'The tab row fits the screen',
        async (page) => {
          const wide = await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth + 1,
          );
          if (wide) throw red('the page scrolls sideways at phone width');
        },
      ],
      [
        "A client's Workbench",
        notHere(
          'the made-up reads hold no client record (clients are added from the command line)',
        ),
      ],
      [
        'An address that is not built: one plain page',
        async (page, at) => {
          await go(page, at, '/nowhere-built/');
          await expectVisible('the Not found page', () =>
            page.getByRole('heading', { name: 'Not found' }),
          );
        },
      ],
    ],
  },
  {
    unit: 'U07',
    issue: 677,
    title: 'App strip, face switch, search, person menu and Settings General (1 of 2)',
    width: PHONE,
    start: '/settings',
    steps: [
      [
        'Appearance to Dark and Guided tips off',
        async (page) => {
          const dark = page
            .getByRole('group', { name: 'Appearance' })
            .getByRole('button', { name: 'Dark' });
          await dark.scrollIntoViewIfNeeded();
          await dark.click();
          await page.waitForTimeout(BEAT);
          await page
            .getByRole('group', { name: 'Guided tips' })
            .getByRole('button', { name: 'Off' })
            .click();
          await page.waitForTimeout(BEAT);
          for (const [group, name] of [
            ['Appearance', 'Dark'],
            ['Guided tips', 'Off'],
          ] as const) {
            const pressed = await page
              .getByRole('group', { name: group })
              .getByRole('button', { name })
              .getAttribute('aria-pressed');
            if (pressed !== 'true') throw red(`${group} did not take ${name}`);
          }
        },
      ],
      [
        'Both settings stick after signing out and in',
        notHere('needs a real sign-in; the made-up reads do not keep a write'),
      ],
      [
        'Inside a client, press Client then Agency: the teal strip',
        notHere('the made-up reads hold no client record'),
      ],
    ],
  },
  {
    unit: 'U08, U12',
    issue: 678,
    title: 'Dock frame, geometry and the gesture law',
    width: LAPTOP,
    start: '/projects/',
    steps: [
      [
        'Click a dock tab, then shift-click a second: two panels side by side',
        async (page) => {
          await page.getByRole('button', { name: /^Open Notifications/u }).click();
          await page.waitForTimeout(BEAT);
          await page.getByRole('button', { name: /^Open Team/u }).click({ modifiers: ['Shift'] });
          await page.waitForTimeout(BEAT);
          await expectVisible('the Notifications panel', () =>
            page.getByRole('button', { name: 'Close Notifications', exact: true }),
          );
          await expectVisible('the Team panel beside it', () =>
            page.getByRole('button', { name: 'Close Team', exact: true }),
          );
        },
      ],
      [
        'Drag a panel grip wider',
        async (page) => {
          const grip = page.getByRole('separator').filter({ hasNotText: 'Menu width' }).last();
          const box = await grip.boundingBox();
          if (box === null) throw red('no panel grip');
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 12 });
          await page.mouse.up();
        },
      ],
      [
        'Each X closes its own panel',
        async (page) => {
          await page.getByRole('button', { name: 'Close Notifications', exact: true }).click();
          await page.waitForTimeout(BEAT);
          if (
            await page.getByRole('button', { name: 'Close Notifications', exact: true }).isVisible()
          )
            throw red('the Notifications X left its panel open');
          await expectVisible('the Team panel still open', () =>
            page.getByRole('button', { name: 'Close Team', exact: true }),
          );
          await page.getByRole('button', { name: 'Close Team', exact: true }).click();
        },
      ],
      [
        'The panel width is kept next time',
        notHere('the made-up reads keep no saved width (preference.read answers no dock.width)'),
      ],
    ],
  },
  {
    unit: 'U10',
    issue: 680,
    title: 'Access, second factor, service health, operations view and the legal basics (2 of 2)',
    width: PHONE,
    start: '/settings/operations/',
    steps: [
      [
        'The operations view: watcher status and last restore date',
        async (page) => {
          await expectVisible('Unattended', () =>
            page.getByRole('heading', { name: 'Unattended' }),
          );
          await page.getByRole('heading', { name: 'Last tested restore' }).scrollIntoViewIfNeeded();
          await page.waitForTimeout(BEAT);
          await page.getByRole('heading', { name: 'Service health' }).scrollIntoViewIfNeeded();
        },
      ],
      [
        'The teammate signs in: authenticator code asked, a wrong code refused',
        notHere(
          'needs the made-up teammate login with an authenticator (Bitwarden), not prepared in this lane',
        ),
      ],
      [
        'The privacy policy from the sign-in page',
        async (page) => {
          // Signed out from the person menu, so no load re-adds the made-up session.
          await page.getByRole('button', { name: /signed in$/u }).click();
          await page
            .getByRole('menuitem', { name: /sign out/iu })
            .or(page.getByRole('button', { name: /sign out/iu }))
            .first()
            .click();
          await expectVisible('the sign-in form', () =>
            page.getByRole('form', { name: 'Sign in' }),
          );
          // The legal links are for the business typed into the form (SignIn.tsx).
          await page.getByRole('textbox', { name: 'Business' }).fill('alpha');
          await page.waitForTimeout(BEAT);
          const link = page.getByRole('link', { name: 'Privacy policy' });
          await expectVisible('the Privacy policy link on sign-in', () => link);
          await link.click();
          await expectVisible('the Legal page', () =>
            page.getByRole('heading', { name: 'Legal', level: 1 }),
          );
        },
      ],
      [
        'Every outside service listed with what it receives',
        notHere('the made-up reads do not answer the public legal document read'),
      ],
    ],
  },
];
