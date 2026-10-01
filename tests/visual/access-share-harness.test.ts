// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- widths and states run one at a time, in order:
   one browser context at a time. */
//
// The made-up world's signed-in person holds `access:share` (C39-T, P3B), so
// a capture of Settings ▸ Access draws "Invite a team member" and the
// business's invitations, one in each state, rather than the page without
// them. The capture runs in the pinned headless shell at 1480 and 390, light;
// the invite section is photographed on its own, as it sits below the fold.
// Pictures land in .local/evidence/visual/access-share (gitignored). No
// browser, no capture: the launch fails the test, never skips it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import type {
  CapabilitiesResult,
  InvitationListResult,
} from '../../packages/core-wire/src/index.ts';
import { pathOf, PREFIX } from '../../packages/core-wire/src/index.ts';
import { launchChromium } from '../support/chromium.ts';
import { captureBuiltPages, MADE_UP_PARAMS, madeUpSession, serveApp } from './app-pages.ts';
import { load, openSide, shoot } from './capture.ts';
import { answerMadeUp, madeUpAnswer } from './made-up-api.ts';
import { fetchAssets, MODE, readAssets, readPacket, type Packet } from './packet.ts';
import { addressOf, report } from './report.ts';

const PAGE = 'agency:access';
const WIDTHS = [1480, 390];
const STATES = ['pending', 'accepted', 'revoked', 'expired'] as const;
const SECTION = 'section.sec:has([data-access="invite"])';
type Harness = { browser: Browser; packet: Packet; app: URL; session: string };

const out = new URL('../../.local/evidence/visual/access-share', import.meta.url).pathname;

/** One width's invite section, from the made-up reads: its form and every invitation state. */
async function inviteSectionAt(at: Harness, width: number): Promise<void> {
  const { browser, packet, app, session } = at;
  const side = await openSide(browser, packet, width, { app, session, colorScheme: 'light' });
  try {
    await answerMadeUp(side.context);
    const page = await load(
      side,
      packet,
      new URL(addressOf(PAGE, MADE_UP_PARAMS) ?? '/', app).href,
    );
    await page.waitForSelector('[data-access="invitations"] [data-state]', { timeout: 10_000 });
    expect(await page.locator('[data-access="invite"] form').count()).toBe(1);
    for (const state of STATES) {
      const row = page.locator(`[data-access="invitations"] [data-state="${state}"]`);
      expect(await row.count(), state).toBe(1);
    }
    const [section] = await shoot(page, `${PAGE}@${width}-light`, { invite: SECTION }, []);
    if (section !== undefined)
      writeFileSync(join(out, `${section.name.replace('#', '.')}.png`), section.png);
  } finally {
    await side.context.close();
  }
}

const read = <T>(name: Parameters<typeof pathOf>[0]): T =>
  madeUpAnswer(`${PREFIX.person}alpha${pathOf(name)}`)?.json as T;

describe("the made-up world's Settings ▸ Access under access:share", () => {
  it('the made-up session holds access:share', () => {
    const { grants } = read<CapabilitiesResult>('session.capabilities');
    expect(grants).toContainEqual({ collection: 'access', action: 'share' });
  });

  it('the made-up invitations hold one in each state', () => {
    const { invitations } = read<InvitationListResult>('invitation.list');
    expect(invitations.map((each) => each.state).toSorted()).toEqual([...STATES].toSorted());
  });

  it('a capture at 1480 and 390, light, draws the invite form and every invitation state', async () => {
    const packet = readPacket();
    await fetchAssets(readAssets(), packet);
    const browser = await launchChromium(MODE);
    const { app, close } = await serveApp();
    try {
      mkdirSync(out, { recursive: true });
      const session = madeUpSession(app, join(out, 'session'));
      const themes = ['light'] as const;
      const pages = [PAGE];
      const options = { browser, packet, app, session, out, pages, widths: WIDTHS, themes };
      const all = report({ ...packet, widths: WIDTHS }, pages, await captureBuiltPages(options));
      expect(all.lines.filter((line) => line.startsWith(`ok ${PAGE}@`))).toHaveLength(2);
      for (const width of WIDTHS) await inviteSectionAt({ browser, packet, app, session }, width);
    } finally {
      await browser.close();
      await close();
    }
  }, 600_000);
});
