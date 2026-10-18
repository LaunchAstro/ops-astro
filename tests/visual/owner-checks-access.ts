// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// The owner checks of search, the person menu, access and the agent credential
// (U11, U14, U17, U18), as the owner checks issue (ops-astro#1750) words them.
import {
  BEAT,
  LAPTOP,
  TABLET,
  expectVisible,
  notHere,
  red,
  type Check,
} from './owner-checks-steps.ts';
import { loginOf } from './owner-checks-source.ts';

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
    unit: 'U14',
    issue: 684,
    title: 'Access, second factor, service health and operations view (1 of 2)',
    width: LAPTOP,
    start: '/settings/access/',
    steps: [
      [
        'Settings > Access lists the team, each with End access',
        async (page) => {
          await expectVisible('End access', () => page.getByRole('button', { name: 'End access' }));
          await page.getByRole('heading', { name: 'Give access' }).scrollIntoViewIfNeeded();
        },
      ],
      [
        'Give the teammate one client, check the preview, end access: their session signs out',
        async (page) => {
          if (loginOf('TEAMMATE') === undefined) {
            throw red(
              'no made-up teammate login in OWNER_CHECK_TEAMMATE_EMAIL and _PASSWORD; waits on ops-astro#1808',
            );
          }
          const give = page.getByRole('heading', { name: 'Give access' });
          if ((await give.count()) === 0) throw red('no Give access section on Settings > Access');
          await give.scrollIntoViewIfNeeded();
          await expectVisible('a preview of what the teammate may see', () =>
            page.getByRole('button', { name: /preview/iu }),
          );
          throw red('the preview and the session end are not filmed yet; ops-astro#1814');
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
  {
    unit: 'U18',
    issue: 688,
    title: 'Agent credential on Settings > Access, and the first-client gate',
    width: LAPTOP,
    start: '/settings/access/',
    steps: [
      [
        'Settings > Access lists agents with Revoke delegation',
        async (page) => {
          await page.getByRole('heading', { name: 'Agents' }).scrollIntoViewIfNeeded();
          await expectVisible('Revoke delegation', () =>
            page.getByRole('button', { name: 'Revoke delegation' }),
          );
        },
      ],
      [
        'Make a task-only credential, the agent adds a task, revoke: the next command refused',
        async (page) => {
          const agents = page.getByRole('heading', { name: 'Agents' });
          if ((await agents.count()) === 0) throw red('no Agents section on Settings > Access');
          await agents.scrollIntoViewIfNeeded();
          await expectVisible('a control to make an agent credential', () =>
            page.getByRole('button', { name: /credential|agent key/iu }),
          );
          throw red(
            'the agent command and the refusal after revoking are not filmed yet; ops-astro#1814',
          );
        },
      ],
    ],
  },
];
