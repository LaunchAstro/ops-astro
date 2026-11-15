// SPDX-License-Identifier: AGPL-3.0-only
//
// The change-request panel (C57 part C, #2119) on MP-1-7's width-and-theme harness: one
// request in each phase with the decide controls, the same without `proposal:decide`, a reader
// the server refused, and a client pin to file while the agent's filing waits on a local model.
// Each is drawn in the pinned headless shell at 1480, 900 and 390, light and dark; each picture
// must exist as a PNG as wide as its width, scroll no way sideways, and draw differently in
// dark than in light.

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangeRequestPanel } from '../../apps/web/src/screens/review/ChangeRequests.tsx';
import { pin, props, request } from '../web/c57-change-request-fixtures.ts';
import { comparePng } from './compare.ts';
import { captureSurfaces, WIDTHS, type Surface } from './kit-captures.ts';
import { readPacket } from './packet.ts';
import { report, type PageShot } from './report.ts';

const EACH_PHASE = [
  request({ changeRequestId: 'p', text: 'Move the heading above the photo on phones' }),
  request({
    changeRequestId: 'w',
    state: 'approved',
    text: 'Use the new phone number in the footer',
  }),
  request({
    changeRequestId: 'm',
    state: 'approved',
    createdTaskId: 'task-made',
    text: 'Swap the hero photo for the clinic front',
  }),
  request({ changeRequestId: 'r', state: 'refused', text: 'Make the whole page orange' }),
];

const ready = { kind: 'ready', requests: EACH_PHASE, pins: [] } as const;

const STATES = [
  ['change-dock-decider', props({ load: ready })],
  ['change-dock-reader', props({ load: ready, canDecide: false })],
  [
    'change-dock-refused-reader',
    props({ load: { kind: 'refused', because: 'NOT_FOUND. Nothing here you can read.' } }),
  ],
  [
    'change-dock-filing-waits',
    props({
      agent: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK',
      note: 'An agent’s filing waits on a local model.',
      load: { kind: 'ready', requests: [], pins: [pin({ body: 'Can the photo sit lower?' })] },
    }),
  ],
] as const;

const markup = new Map(
  STATES.map(([id, state]) => [id, renderToStaticMarkup(<ChangeRequestPanel {...state} />)]),
);

let out = '';
let shots: PageShot[];
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'c57-change-dock-harness-'));
  const all: Surface[] = STATES.map(([id]) => ({ id, markup: markup.get(id) ?? '' }));
  shots = await captureSurfaces(all, join(out, 'captures'));
}, 600_000);
afterAll(() => {
  // Kept for the lane's look check when asked; the run's own copy goes.
  const keep = process.env['CHANGE_DOCK_CAPTURES'];
  if (keep !== undefined && keep !== '') cpSync(join(out, 'captures'), keep, { recursive: true });
  rmSync(out, { recursive: true, force: true });
});

describe('change-request panel on the width-and-theme harness (MP-1-7)', () => {
  it('C57 harness captures: each phase with controls and without, a refused reader and filing, light and dark at 1480, 900 and 390', () => {
    expect((markup.get('change-dock-decider') ?? '').match(/data-decide=/gu)).toHaveLength(2);
    expect(markup.get('change-dock-reader')).not.toContain('data-decide=');
    expect(markup.get('change-dock-refused-reader')).not.toContain('Move the heading');
    expect(markup.get('change-dock-filing-waits')).toContain('waits on a local model');
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
