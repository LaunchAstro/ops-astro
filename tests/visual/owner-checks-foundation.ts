// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a step clicks, then looks, in order: the film shows one after the next */
//
// The owner checks of the hosting, tooling, backup and foundation units
// (U01 to U05), as the owner checks issue (ops-astro#1750) words them.
import { BUILD_SELECTOR } from '../browser/served-build.ts';
import {
  BEAT,
  LAPTOP,
  PHONE,
  expectVisible,
  go,
  notHere,
  red,
  reload,
  type Check,
} from './owner-checks-steps.ts';

export const FOUNDATION: readonly Check[] = [
  {
    unit: 'U01',
    issue: 671,
    title: 'Staging and alerts: the isolated copy, its first deploy and alerts in plain words',
    width: PHONE,
    start: '/projects/',
    steps: [
      [
        'The build in the menu matches the build this pack names',
        async (page, at) => {
          await page.getByRole('button', { name: /open the menu/iu }).click();
          const shown = await page.locator(BUILD_SELECTOR).first().getAttribute('data-build');
          if (shown !== at.stamp) throw red(`menu shows ${String(shown)}, pack is ${at.stamp}`);
        },
      ],
      [
        'Only made-up clients on the board',
        async (page) => {
          await page.getByRole('button', { name: 'Close the menu' }).click();
          await expectVisible('a made-up task', () =>
            page.getByRole('link', { name: /contract review pack/iu }),
          );
        },
      ],
      [
        'A test alert from production in plain words',
        notHere('production alert; waits on ops-astro#1736'),
      ],
    ],
  },
  {
    unit: 'U02',
    issue: 672,
    title: 'Required-check tooling: the width-and-theme harness, the route manifest and parity',
    width: LAPTOP,
    start: '/settings/access/',
    steps: [
      [
        'A route pasted into the address bar opens its page, and again on reload',
        async (page) => {
          await expectVisible('the Access heading', () =>
            page.getByRole('heading', { name: 'Access', level: 1 }),
          );
          await reload(page);
          await expectVisible('the Access heading after reload', () =>
            page.getByRole('heading', { name: 'Access', level: 1 }),
          );
        },
      ],
      [
        'Another route: the operations view',
        async (page, at) => {
          await go(page, at, '/settings/operations/');
          await expectVisible('the Operations heading', () =>
            page.getByRole('heading', { name: 'Operations', level: 1 }),
          );
        },
      ],
      [
        'The width-and-theme and parity reports',
        notHere('reports from the visual drift and parity CI jobs, linked on the unit'),
      ],
    ],
  },
  {
    unit: 'U03',
    issue: 673,
    title: 'Backups, a tested restore drill and CI on the hosted database major',
    width: PHONE,
    start: '/settings/operations/',
    steps: [
      [
        'The operations view shows the last tested restore',
        async (page) => {
          await expectVisible('Last tested restore', () =>
            page.getByRole('heading', { name: 'Last tested restore' }),
          );
          await page.getByRole('heading', { name: 'Last tested restore' }).scrollIntoViewIfNeeded();
        },
      ],
      [
        'The drill receipt from production',
        notHere('reads production evidence; waits on ops-astro#1554'),
      ],
    ],
  },
  {
    unit: 'U04',
    issue: 674,
    title: 'Foundations: tokens, fonts, the component kit and not-connected treatments',
    width: LAPTOP,
    theme: 'dark',
    start: '/gallery/',
    steps: [
      [
        'Dark mode on the computer: the gallery opens dark, and stays dark on reload',
        async (page) => {
          for (const when of ['open', 'reload']) {
            if (when === 'reload') await reload(page);
            const dark = await page.evaluate(() => {
              const [r, g, b] = (
                getComputedStyle(document.body).backgroundColor.match(/\d+/gu) ?? []
              ).map(Number);
              return (r ?? 255) + (g ?? 255) + (b ?? 255) < 3 * 90;
            });
            if (!dark) throw red(`page background is light on ${when}`);
          }
        },
      ],
      [
        'Buttons, chips, tables and cards',
        async (page) => {
          for (const name of [
            /^Button/u,
            /^Chip and pill/u,
            /^Table and cells/u,
            /^Card \(base\)/u,
          ]) {
            const heading = page.getByRole('heading', { name, level: 2 });
            await expectVisible(String(name), () => heading);
            await heading.scrollIntoViewIfNeeded();
            await page.waitForTimeout(BEAT);
          }
        },
      ],
    ],
  },
  {
    unit: 'U05',
    issue: 675,
    title: 'Foundations: type scale and chart primitives',
    width: LAPTOP,
    start: '/dashboard/executive/',
    steps: [
      [
        'Every chart on the Executive page draws, and a hovered point shows its value',
        async (page) => {
          const charts = page.locator('main svg[role="img"], main figure svg, main [data-chart]');
          if ((await charts.count()) === 0) throw red('no chart on the Executive page');
          const box = await charts.first().boundingBox();
          if (box === null) throw red('the first chart has no size');
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await expectVisible('a value on hover', () => page.getByRole('tooltip'));
        },
      ],
      [
        'Five pages side by side with the mockup: text sizes and weights the same',
        notHere('the mockup is private; the look-parity job measures it (tests/visual/look.ts)'),
      ],
    ],
  },
];
