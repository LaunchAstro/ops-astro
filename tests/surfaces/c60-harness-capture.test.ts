// SPDX-License-Identifier: AGPL-3.0-only
//
// C60 on the width-and-theme harness (MP-1-7): Settings ▸ Access with each
// client's privacy settings (model use, health information, no agent edits)
// and the act that changes them, built from the shared kit with no private
// style, in light and dark at 1480, 900 and 390 in the pinned headless shell.
// The page draws a made-up answer to `access.read` (the shape the wire
// declares), and the capture checks it drew a client's settings. No browser,
// no capture: the launch fails the test, never skips it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import {
  answer,
  captureBuiltPages,
  MADE_UP_PARAMS,
  madeUpSession,
  serveApp,
} from '../visual/app-pages.ts';
import { load, openSide } from '../visual/capture.ts';
import { comparePng } from '../visual/compare.ts';
import { fetchAssets, MODE, readAssets, readPacket, themesOf } from '../visual/packet.ts';
import { addressOf, report } from '../visual/report.ts';

const scratch = mkdtempSync(join(tmpdir(), 'c60-captures-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const WIDTHS = [1480, 900, 390];
const PAGE = 'agency:access';
const id = (n: number): string => `c60a4c1e-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ACCESS = {
  ok: true,
  team: [
    {
      personId: id(1),
      name: 'Mia Alpha',
      permissions: [
        { collection: 'privacy', action: 'manage', scope: { kind: 'party', id: id(2) } },
      ],
      grants: [
        {
          grantId: id(3),
          collection: 'privacy',
          action: 'manage',
          scope: { kind: 'party', id: id(2) },
        },
      ],
    },
  ],
  clients: [],
  agents: [],
  clientRecords: [
    { clientId: id(2), name: 'Acme Dental' },
    { clientId: id(4), name: 'Harbour Physio' },
  ],
  clientPrivacy: [
    {
      clientId: id(2),
      modelEgress: false,
      providers: [],
      handlesHealth: false,
      noAgentEdits: false,
    },
    { clientId: id(4), modelEgress: false, providers: [], handlesHealth: true, noAgentEdits: true },
  ],
};

const DRAWN = `[data-client-privacy="${id(4)}"]`;

type Packet = ReturnType<typeof readPacket>;
type At = {
  readonly browser: Browser;
  readonly packet: Packet;
  readonly app: URL;
  readonly session: string;
};

const ANSWERS = { 'access/read': ACCESS };

/** The page at every width and theme: the report passes and each dark picture differs. */
async function capturedEverywhere(at: At, out: string): Promise<void> {
  const { packet } = at;
  const themes = themesOf(packet);
  expect(themes).toContain('dark');
  const shots = await captureBuiltPages({
    ...at,
    widths: WIDTHS,
    themes,
    out,
    pages: [PAGE],
    answers: ANSWERS,
  });
  const all = report({ ...packet, widths: WIDTHS }, [PAGE], shots);
  expect(all.failed, all.lines.join('\n')).toBe(0);
  const file = (width: number, theme: string): Buffer =>
    readFileSync(join(out, `${PAGE}@${width}-${theme}.page.png`));
  for (const width of WIDTHS) {
    const same = comparePng(`${PAGE}@${width}`, file(width, 'light'), file(width, 'dark'));
    expect(same.pass, `${PAGE}@${width} dark draws the same as light`).toBe(false);
  }
}

/** The pictures are of the client privacy card, drawn from the made-up read. */
async function cardDrawn(at: At): Promise<void> {
  const { browser, packet, app, session } = at;
  const side = await openSide(browser, packet, 390, { app, session });
  try {
    await answer(side, ANSWERS);
    const address = new URL(addressOf(PAGE, MADE_UP_PARAMS) ?? '/', app).href;
    const shown = await load(side, packet, address);
    await shown.waitForSelector(DRAWN, { timeout: 10_000 });
    const card = await shown.locator(DRAWN).textContent();
    expect(card).toContain('Harbour Physio');
    expect(card).toContain('Model use off');
    expect(await shown.locator('[data-access="client-privacy"] form').count()).toBe(1);
  } finally {
    await side.context.close();
  }
}

async function c60HarnessCapture(): Promise<void> {
  const packet = readPacket();
  await fetchAssets(readAssets(), packet);
  const browser = await launchChromium(MODE);
  const { app, close } = await serveApp();
  try {
    const out = join(scratch, 'access');
    const at = { browser, packet, app, session: madeUpSession(app, out) };
    await capturedEverywhere(at, out);
    await cardDrawn(at);
  } finally {
    await browser.close();
    await close();
  }
}

describe('C60 client privacy on the width-and-theme harness (MP-1-7)', () => {
  it(
    'C60 harness capture: Settings ▸ Access with each client privacy settings, in light and dark at 1480, 900 and 390',
    c60HarnessCapture,
    600_000,
  );
});
