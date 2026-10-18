// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// The owner checks of search, the person menu and the rail (U11, U17), as the
// owner checks issue (ops-astro#1750) words them. U14 and U18 are filmed when
// their screens exist (ops-astro#1819, #1818).
import {
  BEAT,
  LAPTOP,
  TABLET,
  expectVisible,
  notHere,
  red,
  type Check,
} from './owner-checks-steps.ts';

export const ACCESS: readonly Check[] = [
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
        },
      ],
      [
        'Both kept after a reload',
        notHere(
          'the made-up reads keep no saved rail (preference.read answers neither rail key), so a reload draws the default',
        ),
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
