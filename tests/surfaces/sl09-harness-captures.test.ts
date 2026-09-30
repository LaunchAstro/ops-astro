// SPDX-License-Identifier: AGPL-3.0-only
//
// SL09's pages on the width-and-theme harness (MP-1-7), one named capture per
// ticket: C55's operations view and C58's Settings ▸ Access, each in light and
// dark at 1480, 900 and 390, in the pinned headless shell. Each page draws
// made-up answers to its own read (the shapes the wire declares), so the
// pictures show its sections rather than its could-not-be-read state, and each
// capture checks the page drew them. No browser, no capture: the launch fails
// the test, never skips it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import { answer, captureBuiltPages, madeUpSession, serveApp } from '../visual/app-pages.ts';
import { load, openSide } from '../visual/capture.ts';
import { comparePng } from '../visual/compare.ts';
import {
  fetchAssets,
  MODE,
  readAssets,
  readPacket,
  themesOf,
  type Packet,
} from '../visual/packet.ts';
import { addressOf, report } from '../visual/report.ts';

const scratch = mkdtempSync(join(tmpdir(), 'sl09-captures-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const WIDTHS = [1480, 900, 390];
const id = (n: number): string => `5b0a4c1e-0000-4000-8000-${String(n).padStart(12, '0')}`;

const OPERATIONS = {
  ok: true,
  unattended: [
    {
      id: id(1),
      recipientPersonId: id(2),
      subjectRecordId: id(3),
      reason: 'decision',
      factKind: 'gate',
      factId: id(4),
      raisedAt: '2026-09-30T08:00:00.000Z',
    },
  ],
  privacyIncidents: [
    {
      id: id(5),
      whatHappened: 'A made-up export went to the wrong inbox',
      foundAt: '2026-08-20T09:00:00.000Z',
      foundBy: 'Ada',
      affected: 'Two made-up contacts',
      informationKinds: ['contact'],
      assessBy: '2026-09-19T09:00:00.000Z',
      overdue: true,
      status: 'open',
      recordedAt: '2026-08-20T09:05:00.000Z',
      recordedByActorId: id(6),
    },
  ],
  breachRunbook: {
    version: '1.0',
    digest: 'sha256:made-up',
    publishedAt: '2026-09-28T00:00:00.000Z',
    body: '# Breach runbook',
  },
  serviceHealth: {
    checkedAt: '2026-09-30T08:00:00.000Z',
    sources: [{ source: 'watcher', state: 'read', fault: null }],
    services: [
      { source: 'watcher', name: 'api', state: 'healthy', lastObservedAt: '2026-09-30T07:59:00Z' },
    ],
  },
};

const MIA = {
  personId: id(7),
  name: 'Mia Alpha',
  permissions: [{ collection: 'tasks', action: 'read', scope: { kind: 'business', id: null } }],
  grants: [
    { grantId: id(8), collection: 'tasks', action: 'read', scope: { kind: 'business', id: null } },
  ],
};

const ACCESS = {
  ok: true,
  team: [MIA],
  clients: [],
  agents: [],
  clientRecords: [{ clientId: id(9), name: 'Acme Dental' }],
};

/** The page, loaded at 390 with the made-up answers, draws `drawn`. */
async function sectionsDrawn(
  at: { browser: Browser; packet: Packet; app: URL; session: string },
  page: string,
  answers: Readonly<Record<string, unknown>>,
  drawn: string,
): Promise<void> {
  const { browser, packet, app, session } = at;
  const side = await openSide(browser, packet, 390, { app, session });
  try {
    await answer(side, answers);
    const shown = await load(side, packet, new URL(addressOf(page, {}) ?? '/', app).href);
    await shown.waitForSelector(drawn, { timeout: 10_000 });
    expect(await shown.locator(drawn).count()).toBeGreaterThan(0);
  } finally {
    await side.context.close();
  }
}

/**
 * The pages at every width and theme, each checked to have drawn `drawn`:
 * the report passes, and each dark picture differs from its light one.
 */
async function capturesOf(
  page: string,
  answers: Readonly<Record<string, unknown>>,
  drawn: string,
): Promise<void> {
  const packet = readPacket();
  await fetchAssets(readAssets(), packet);
  const browser = await launchChromium(MODE);
  const { app, close } = await serveApp();
  try {
    const out = join(scratch, page.replace(':', '_'));
    const session = madeUpSession(app, out);
    const themes = themesOf(packet);
    expect(themes).toContain('dark');
    const shots = await captureBuiltPages({
      browser,
      packet,
      app,
      session,
      widths: WIDTHS,
      themes,
      out,
      pages: [page],
      answers,
    });
    const all = report({ ...packet, widths: WIDTHS }, [page], shots);
    expect(all.failed, all.lines.join('\n')).toBe(0);
    const file = (width: number, theme: string): Buffer =>
      readFileSync(join(out, `${page}@${width}-${theme}.page.png`));
    for (const width of WIDTHS) {
      expect(all.lines).toContain(
        `ok ${page}@${width}-dark: ${page}@${width}-dark.page.png; no sideways scroll`,
      );
      const same = comparePng(`${page}@${width}`, file(width, 'light'), file(width, 'dark'));
      expect(same.pass, `${page}@${width} dark draws the same as light`).toBe(false);
    }
    // The pictures are of the page's sections, drawn from the made-up read.
    await sectionsDrawn({ browser, packet, app, session }, page, answers, drawn);
  } finally {
    await browser.close();
    await close();
  }
}

describe('SL09 pages on the width-and-theme harness (MP-1-7)', () => {
  it('C55 harness capture: the operations view in light and dark at 1480, 900 and 390', async () => {
    await capturesOf(
      'agency:operations',
      { 'operations/read': OPERATIONS },
      `[data-unattended="${id(1)}"]`,
    );
  }, 600_000);

  it('C58 harness captures: Settings ▸ Access with its End access act, in light and dark at 1480, 900 and 390', async () => {
    await capturesOf('agency:access', { 'access/read': ACCESS }, `[data-end="${MIA.personId}"]`);
  }, 600_000);
});
