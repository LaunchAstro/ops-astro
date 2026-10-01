// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- widths, themes and pages run one at a time,
   in order: one browser context at a time, so each page is measured alone. */
//
// MP-1-4's visual match on the drawn pages: every page the app registers, in
// the pinned headless shell at 1480, 900 and 390 in light and dark, served
// from source (`app-pages.ts`). Sign-in is drawn signed out, every working
// page signed in with the made-up session. In each drawn page every element
// that draws text is measured as the browser computes it (family, size,
// weight, line height, tracking, case) and must be one of the 23 type styles,
// each resolved in that same page by a probe set to `font: var(--type-x)`
// with its tracking and case. An element under a listed exception's selector
// (the census's own, with its ruling) is counted apart, never refused. No
// browser: the launch throws, so the test on this report fails.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchChromium } from '../support/chromium.ts';
import { madeUpSession, screenOf, serveApp } from '../visual/app-pages.ts';
import { load, openSide, type Side } from '../visual/capture.ts';
import { scrollMetrics } from '../visual/drift.ts';
import { WIDTHS } from '../visual/gallery-views.ts';
import {
  fetchAssets,
  MODE,
  readAssets,
  readPacket,
  themesOf,
  type Packet,
  type Theme,
} from '../visual/packet.ts';
import { addressOf, builtPages, needsSession, overflowOf } from '../visual/report.ts';

export type PageCensus = {
  /** `<page>@<width>-<theme>`. */
  name: string;
  /** Which screen was drawn: the page itself, or sign-in for the public page. */
  drew: string;
  sideways: number;
  /** Elements measured that draw text. */
  counted: number;
  /** How many drawn elements each type style set. */
  styles: Record<string, number>;
  /** How many drawn elements each listed exception covered. */
  exceptions: Record<string, number>;
  /** Drawn text in no type style and under no exception: its tag, class, words and style. */
  strays: string[];
};

/** A computed text style: family, size, weight, line height, tracking, case. */
type Look = string[];
type Drawn = { what: string; look: Look; select: boolean; exception: string | undefined };

/** Runs in the page: each named type style as the page resolves it, on a probe. */
export function looksOfStyles(names: string[]): Look[] {
  // A transition still running (a size settling as the sheets arrive) is
  // finished first: the census reads the page as it rests.
  for (const animation of document.getAnimations()) animation.finish();
  return names.map((name) => {
    const probe = document.createElement('span');
    probe.style.setProperty('font', `var(${name})`);
    probe.style.setProperty('letter-spacing', `var(${name}-tracking)`);
    probe.style.setProperty('text-transform', `var(${name}-case)`);
    probe.textContent = 'Aa';
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const look = [
      style.fontFamily,
      style.fontSize,
      style.fontWeight,
      style.lineHeight,
      style.letterSpacing,
      style.textTransform,
    ];
    probe.remove();
    return look;
  });
}

/** Runs in the page: every drawn element that draws text, with its computed look. */
export function drawnText(exceptions: string[]): Drawn[] {
  const inputs = new Set(['text', 'email', 'search', 'password', 'number', 'url', 'tel', 'date']);
  const drawn: Drawn[] = [];
  for (const element of document.body.querySelectorAll('*')) {
    const text =
      (element instanceof HTMLInputElement && inputs.has(element.type)) ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
      );
    if (!text || !element.checkVisibility({ visibilityProperty: true })) continue;
    if (element.getClientRects().length === 0) continue;
    const style = getComputedStyle(element);
    const look = [
      style.fontFamily,
      style.fontSize,
      style.fontWeight,
      style.lineHeight,
      style.letterSpacing,
      style.textTransform,
    ];
    const words = (element.textContent ?? '').trim().slice(0, 30);
    drawn.push({
      what: `${element.tagName.toLowerCase()}.${element.getAttribute('class') ?? ''} "${words}"`,
      look,
      select: element instanceof HTMLSelectElement,
      exception: exceptions.find((selector) => element.closest(selector) !== null),
    });
  }
  return drawn;
}

// The browser's own sheet fixes a select's line height at `normal` above any
// author rule, so a select is matched without it.
const keyOf = (look: Look, select: boolean): string =>
  (select ? look.with(3, 'normal') : look).join(' | ');

/** Each drawn element matched to the styles it draws in, an exception, or a stray. */
export function matchStyles(
  names: string[],
  looks: Look[],
  drawn: Drawn[],
): Omit<PageCensus, 'name' | 'drew' | 'sideways'> {
  const styles: Record<string, number> = {};
  const exceptions: Record<string, number> = {};
  const strays: string[] = [];
  for (const one of drawn) {
    const key = keyOf(one.look, one.select);
    const matched = names.filter((_name, at) => keyOf(looks[at] ?? [], one.select) === key);
    for (const name of matched) styles[name] = (styles[name] ?? 0) + 1;
    if (matched.length > 0) continue;
    if (one.exception === undefined) strays.push(`${one.what}: ${key}`);
    else exceptions[one.exception] = (exceptions[one.exception] ?? 0) + 1;
  }
  return { counted: drawn.length, styles, exceptions, strays };
}

/** One drawn page, measured once none of its sheets is still in flight. */
async function measure(
  page: Page,
  given: { names: string[]; exceptions: string[] },
): Promise<Omit<PageCensus, 'name'>> {
  // Served from source, the sheets arrive as modules: measure once none is in flight.
  await page.waitForLoadState('networkidle');
  const drew = await page.evaluate(screenOf);
  const sideways = overflowOf(await page.evaluate(scrollMetrics));
  const looks = await page.evaluate(looksOfStyles, given.names);
  const drawn = await page.evaluate(drawnText, given.exceptions);
  return { drew, sideways, ...matchStyles(given.names, looks, drawn) };
}

/** Every built page at one width in one theme, each on the side its route asks for. */
async function eachPage(
  sides: { signedOut: Side; signedIn: Side },
  at: { packet: Packet; app: URL; width: number; theme: Theme },
  given: { names: string[]; exceptions: string[] },
): Promise<PageCensus[]> {
  const out: PageCensus[] = [];
  for (const id of builtPages()) {
    const side = needsSession(id) ? sides.signedIn : sides.signedOut;
    const address = addressOf(id, { key: 'T-1' }) ?? '/';
    const page = await load(side, at.packet, new URL(address, at.app).href);
    out.push({ name: `${id}@${String(at.width)}-${at.theme}`, ...(await measure(page, given)) });
    await page.close();
  }
  return out;
}

/** The census over every built page at each width in each theme. */
export async function pageCensus(given: {
  names: string[];
  exceptions: string[];
}): Promise<PageCensus[]> {
  const packet = readPacket();
  await fetchAssets(readAssets(), packet);
  const browser = await launchChromium(MODE);
  const { app, close } = await serveApp();
  const dir = mkdtempSync(join(tmpdir(), 'page-census-'));
  const out: PageCensus[] = [];
  try {
    const session = madeUpSession(app, dir);
    for (const width of WIDTHS) {
      for (const theme of themesOf(packet)) {
        const signedOut = await openSide(browser, packet, width, { app, colorScheme: theme });
        const signedIn = await openSide(browser, packet, width, {
          app,
          session,
          colorScheme: theme,
        });
        try {
          out.push(
            ...(await eachPage({ signedOut, signedIn }, { packet, app, width, theme }, given)),
          );
        } finally {
          await Promise.all([signedOut.context.close(), signedIn.context.close()]);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await browser.close();
    await close();
  }
  return out;
}
