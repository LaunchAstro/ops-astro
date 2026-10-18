// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// The owner checks of access and the second factor, search, the person menu
// and the rail (U10, U11, U17), as the owner checks issue (ops-astro#1750)
// words them. U14 and U18 are filmed when
// their screens exist (ops-astro#1819, #1818).
import type { Page } from 'playwright';
import {
  BEAT,
  LAPTOP,
  PHONE,
  TABLET,
  expectVisible,
  notHere,
  red,
  reload,
  signIn,
  type Check,
} from './owner-checks-steps.ts';
import { loginOf } from './owner-checks-source.ts';

/** The rail width each film's drag left, read back after its reload. */
const savedRail = new WeakMap<Page, number>();

export const ACCESS: readonly Check[] = [
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
      [
        'The teammate signs in: authenticator code asked, a wrong code refused',
        async (page, at) => {
          const login = loginOf('TEAMMATE');
          if (login === undefined) {
            throw red(
              'no made-up teammate login in OWNER_CHECK_TEAMMATE_EMAIL and _PASSWORD; waits on ops-astro#1808',
            );
          }
          await signIn(page, at, login);
          await expectVisible('the authenticator code step', () =>
            page.locator('[data-sign-in="code"]'),
          );
          const code = page.getByRole('textbox', { name: 'Authenticator code' });
          await code.fill('000000');
          await page.getByRole('button', { name: 'Continue' }).click();
          const refused = await page
            .waitForFunction(
              () =>
                document
                  .querySelector('[data-step-up="code"], input[aria-invalid="true"]')
                  ?.getAttribute('aria-invalid') === 'true',
              undefined,
              { timeout: 8000 },
            )
            .then(() => true)
            .catch(() => false);
          if (!refused) throw red('a wrong code was not refused');
          await page.getByRole('button', { name: 'Cancel' }).click();
        },
      ],
    ],
  },
  {
    unit: 'U11',
    issue: 681,
    title: 'App strip, face switch, search, person menu and Settings General (2 of 2)',
    width: LAPTOP,
    start: '/projects/',
    steps: [
      [
        'Cmd-K, part of a task name, Enter: the task opens',
        async (page) => {
          await page.keyboard.press('ControlOrMeta+k');
          await page.waitForTimeout(BEAT / 2);
          await page.keyboard.type('Contract review', { delay: 60 });
          await page.waitForTimeout(BEAT);
          await page.keyboard.press('Enter');
          await page.waitForURL(/\/task\//u, { timeout: 4000 }).catch(() => {
            throw red(`still at ${page.url()}`);
          });
        },
      ],
      [
        'Your name top right: name, settings link, Sign out',
        async (page) => {
          await page.getByRole('button', { name: /signed in$/u }).click();
          await expectVisible('Sign out', () =>
            page
              .getByRole('menuitem', { name: /sign out/iu })
              .or(page.getByRole('button', { name: /sign out/iu })),
          );
          await expectVisible('a settings link', () =>
            page
              .getByRole('menuitem', { name: /settings/iu })
              .or(page.getByRole('link', { name: /settings/iu })),
          );
        },
      ],
    ],
  },
  {
    unit: 'U17',
    issue: 687,
    title: 'Dock tiers, dock history, the width grip on the rail, and the dock task panel (1 of 2)',
    width: LAPTOP,
    start: '/projects/',
    steps: [
      [
        'Collapse the rail, and open it again',
        async (page) => {
          await page.getByRole('button', { name: 'Collapse the menu' }).click();
          await expectVisible('the collapsed rail', () =>
            page.getByRole('button', { name: /expand the menu/iu }),
          );
          await page.waitForTimeout(BEAT);
          await page.getByRole('button', { name: /expand the menu/iu }).click();
        },
      ],
      [
        'Drag the rail wider',
        async (page) => {
          const grip = page.getByRole('separator', { name: 'Menu width' });
          const box = await grip.boundingBox();
          if (box === null) throw red('no rail grip');
          await page.mouse.move(box.x + box.width / 2, box.y + 200);
          await page.mouse.down();
          await page.mouse.move(box.x + 60, box.y + 200, { steps: 12 });
          await page.mouse.up();
          const before = box.x;
          const after = (await grip.boundingBox())?.x ?? before;
          if (after - before < 20)
            throw red(`the rail grip moved ${String(after - before)}px of 60`);
          savedRail.set(page, Number(await grip.getAttribute('aria-valuenow')));
        },
      ],
      [
        'Both kept after a reload',
        async (page) => {
          await reload(page);
          const saved = savedRail.get(page);
          if (saved === undefined) throw red('no rail width was saved by the drag step');
          await expectVisible('the rail left open', () =>
            page.getByRole('button', { name: 'Collapse the menu' }),
          );
          const now = Number(
            await page.getByRole('separator', { name: 'Menu width' }).getAttribute('aria-valuenow'),
          );
          if (Math.abs(now - saved) > 2) {
            throw red(`the rail is ${String(now)}px after a reload, saved ${String(saved)}px`);
          }
        },
      ],
      [
        'At tablet width a panel sits as a sheet',
        async (page) => {
          await page.setViewportSize({ width: TABLET, height: 1000 });
          await page.waitForTimeout(BEAT);
          await page.getByRole('button', { name: /^Open Notifications/u }).click();
          await expectVisible('the panel', () => page.getByRole('button', { name: /^Close/u }));
        },
      ],
    ],
  },
];
