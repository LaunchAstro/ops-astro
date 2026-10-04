// SPDX-License-Identifier: AGPL-3.0-only
//
// The money step-up prompt (C59, U101) on MP-1-7's width-and-theme harness:
// asking for the code, checking it, and a wrong code in the server's words,
// each drawn in the pinned headless shell at 1480, 900 and 390, light and
// dark. Each picture must exist as a PNG as wide as its width, scroll no way
// sideways, and draw differently in dark than in light.

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepUpAsk } from '../../apps/web/src/records/use-money-command.ts';
import { StepUpPrompt } from '../../apps/web/src/views/step-up-prompt.tsx';
import { comparePng } from './compare.ts';
import { captureSurfaces, WIDTHS, type Surface } from './kit-captures.ts';
import { readPacket } from './packet.ts';
import { report, type PageShot } from './report.ts';

const ask = (over: Partial<StepUpAsk>): StepUpAsk => ({
  checking: false,
  because: null,
  way: 'code',
  submit: () => {},
  submitPassword: () => {},
  cancel: () => {},
  ...over,
});

const STATES: readonly (readonly [string, ReactElement])[] = [
  ['step-up-asking', <StepUpPrompt key="a" ask={ask({})} />],
  ['step-up-checking', <StepUpPrompt key="c" ask={ask({ checking: true })} />],
  [
    'step-up-wrong-code',
    <StepUpPrompt key="w" ask={ask({ because: 'That code is not right. Try the current one.' })} />,
  ],
];

let out = '';
let shots: PageShot[];
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'sl11-step-up-harness-'));
  const all: Surface[] = STATES.map(([id, element]) => ({
    id,
    markup: renderToStaticMarkup(element),
  }));
  shots = await captureSurfaces(all, join(out, 'captures'));
}, 600_000);
afterAll(() => {
  // Kept for the lane's look check when asked; the run's own copy goes.
  const keep = process.env['STEP_UP_CAPTURES'];
  if (keep !== undefined && keep !== '') cpSync(join(out, 'captures'), keep, { recursive: true });
  rmSync(out, { recursive: true, force: true });
});

describe('money step-up prompt on the width-and-theme harness (MP-1-7)', () => {
  it('U101 harness captures: asking, checking and a wrong code in light and dark at 1480, 900 and 390', () => {
    const pages = STATES.map(([id]) => id);
    const all = report({ ...readPacket(), widths: [...WIDTHS] }, pages, shots);
    expect(all.failed, all.lines.join('\n')).toBe(0);
    const file = (page: string, width: number, theme: string): Buffer =>
      readFileSync(join(out, 'captures', `${page}@${width}-${theme}.page.png`));
    for (const page of pages)
      for (const width of WIDTHS) {
        for (const theme of ['light', 'dark'])
          expect(all.lines).toContain(
            `ok ${page}@${width}-${theme}: ${page}@${width}-${theme}.page.png; no sideways scroll`,
          );
        const name = `${page}@${width}`;
        const same = comparePng(name, file(page, width, 'light'), file(page, width, 'dark'));
        expect(same.pass, `${name} dark draws the same as light`).toBe(false);
      }
  });
});
