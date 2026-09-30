// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// `visual_fails_on_drift` on a page already loaded in the pinned renderer: an
// unchanged recapture passes, and a control shifted by two pixels or one
// token colour changed fails, naming the capture; a planted element 40px
// wider than the viewport is measured as sideways scroll. Shared by the
// mockup comparison (`run.ts --prove-drift`) and the app-only drift mode
// (`run.ts --app-drift`, `app-drift.ts`).

import type { Page } from 'playwright';
import { shoot } from './capture.ts';
import { comparePng } from './compare.ts';
import { overflowOf } from './report.ts';

/** One report line; `fails` marks it red. */
export type Say = (line: string, fails?: boolean) => void;

export type Drift = {
  /** The control shifted by two pixels. */
  control: string;
  /** The custom property whose colour is changed. */
  token: string;
  /** The region each change must fail in: the one that draws the control. */
  bites: string;
};

export function scrollMetrics(): { scrollWidth: number; clientWidth: number } {
  const root = document.documentElement;
  return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
}

export async function proveDrift(
  page: Page,
  name: string,
  shots: { regions: Record<string, string>; mask: string[]; base: { png: Buffer }[] },
  drift: Drift,
  say: Say,
): Promise<void> {
  const { regions, mask, base } = shots;
  const verdicts = async (): Promise<ReturnType<typeof comparePng>[]> =>
    (await shoot(page, name, regions, mask)).map((s, i) =>
      comparePng(s.name, base[i]?.png ?? Buffer.alloc(0), s.png),
    );
  const bites = (v: ReturnType<typeof comparePng>): boolean =>
    v.pass && v.capture.endsWith(`#${drift.bites}`);
  const unchanged = await verdicts();
  for (const v of unchanged) say(`drift, unchanged recapture: ${v.line}`, !v.pass);
  const { control, token } = drift;
  const shift = await page.addStyleTag({ content: `${control}{position:relative;left:2px}` });
  for (const v of await verdicts())
    say(`drift, control ${control} shifted 2px: ${v.line}`, bites(v));
  await shift.evaluate((node) => (node as Element).remove());
  // The token's own value, shifted a little towards black, on every element
  // that could define it, so the change reaches wherever the token is set.
  const original = await page.evaluate(
    (t) => getComputedStyle(document.body).getPropertyValue(t).trim(),
    token,
  );
  if (original === '') say(`drift, token ${token}: not set on this page`, true);
  const colour = `*{${token}:color-mix(in oklch, ${original} 96%, black) !important}`;
  const recolour = await page.addStyleTag({ content: colour });
  for (const v of await verdicts()) say(`drift, token ${token} changed: ${v.line}`, bites(v));
  await recolour.evaluate((node) => (node as Element).remove());
  // The sideways-scroll measure bites: an element 40px wider than the viewport.
  const planted = await page.addStyleTag({
    content: 'body::after{content:"";display:block;width:calc(100vw + 40px);height:1px}',
  });
  const scroll = overflowOf(await page.evaluate(scrollMetrics));
  say(`overflow, planted 40px: ${name} scrolls sideways by ${scroll} px`, scroll === 0);
  await planted.evaluate((node) => (node as Element).remove());
}
