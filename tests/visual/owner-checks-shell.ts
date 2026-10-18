// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a step clicks, then looks, in order: the film shows one after the next */
//
// The owner checks of the shell and dock units (U06, U07, U08 with U12),
// as the owner checks issue (ops-astro#1750) words them.
import {
  BEAT,
  LAPTOP,
  PHONE,
  expectVisible,
  go,
  notHere,
  red,
  reload,
  signIn,
  type Check,
} from './owner-checks-steps.ts';
import { loginOf } from './owner-checks-source.ts';
import type { Page } from 'playwright';

/** The panel width each film's drag left, read back after its reload. */
const savedPanel = new WeakMap<Page, number>();

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
        async (page, at) => {
          const me = page.getByRole('button', { name: /signed in$/u });
          if ((await me.count()) === 0) throw red('not signed in, so there is no session to end');
          await me.click();
          await page
            .getByRole('menuitem', { name: /sign out/iu })
            .or(page.getByRole('button', { name: /sign out/iu }))
            .first()
            .click();
          await expectVisible('the sign-in form', () =>
            page.getByRole('form', { name: 'Sign in' }),
          );
          const login = loginOf('OWNER');
          if (login === undefined) {
            throw red('no made-up owner login in OWNER_CHECK_OWNER_EMAIL to sign in again');
          }
          await signIn(page, at, login);
          await page.waitForURL((url) => url.pathname !== '/sign-in', { timeout: 15_000 });
          await go(page, at, '/settings');
          for (const [group, name] of [
            ['Appearance', 'Dark'],
            ['Guided tips', 'Off'],
          ] as const) {
            const button = page.getByRole('group', { name: group }).getByRole('button', { name });
            if ((await button.getAttribute('aria-pressed')) !== 'true') {
              throw red(`${group} is not ${name} after signing in again`);
            }
          }
          // The made-up owner's settings go back as they were.
          await page
            .getByRole('group', { name: 'Appearance' })
            .getByRole('button', { name: 'System' })
            .click();
          await page
            .getByRole('group', { name: 'Guided tips' })
            .getByRole('button', { name: 'On' })
            .click();
        },
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
        'Drag a panel grip: the panel narrows',
        async (page) => {
          // The dock's own grip says the panel width it holds (EdgeGrip's aria-valuenow).
          const grip = page.getByRole('separator', { name: 'Panel width', exact: true }).first();
          if ((await grip.count()) === 0) {
            const named = await page
              .getByRole('separator')
              .evaluateAll((all) => all.map((one) => one.getAttribute('aria-label')));
            throw red(`no panel grip among separators ${named.join(', ')}`);
          }
          const box = await grip.boundingBox();
          if (box === null) throw red('the panel grip has no size');
          const before = Number(await grip.getAttribute('aria-valuenow'));
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          // Two panels at laptop width fill the room beside the rail, so the drag narrows.
          await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 12 });
          await page.mouse.up();
          const after = Number(await grip.getAttribute('aria-valuenow'));
          // The panel itself (the grip's own section) must narrow, not only the number it reports.
          const drawn = await grip.evaluate(
            (one) => one.closest('section')?.getBoundingClientRect().width ?? 0,
          );
          if (!(before - after >= 20) || before - drawn < 20) {
            throw red(
              `the panel went from ${String(before)} to ${String(after)}px (drawn ${String(drawn)}px), dragged 120`,
            );
          }
          savedPanel.set(page, after);
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
        async (page) => {
          await reload(page);
          const saved = savedPanel.get(page);
          if (saved === undefined) throw red('no panel width was saved by the drag step');
          await page.getByRole('button', { name: /^Open Notifications/u }).click();
          const grip = page.getByRole('separator', { name: 'Panel width', exact: true }).first();
          await expectVisible('the panel grip', () => grip);
          const now = Number(await grip.getAttribute('aria-valuenow'));
          if (Math.abs(now - saved) > 2) {
            throw red(
              `the panel opened at ${String(now)}px after a reload, saved ${String(saved)}px`,
            );
          }
        },
      ],
    ],
  },
];
