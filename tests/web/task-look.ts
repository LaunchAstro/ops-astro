// SPDX-License-Identifier: AGPL-3.0-only
//
// Which task look probes (tests/visual/look/task.ts) are held to the pinned
// mockup at all six places: 1480, 900 and 390 in both themes. look-parity
// (tests/visual/look-parity.test.ts) compares each in the browser on CI; a
// visual-match case here proves its element is among them, pinned everywhere.

import { readFileSync } from 'node:fs';
import { TASK } from '../visual/look/task.ts';

const PLACES = ['1480', '900', '390'].flatMap((width) =>
  ['light', 'dark'].map((theme) => `${width}-${theme}`),
);

const pinned = JSON.parse(
  readFileSync(new URL('../visual/look/task.mockup.json', import.meta.url), 'utf8'),
) as { readonly probes: Readonly<Record<string, Readonly<Record<string, unknown>>>> };

/** Each named probe at each place it is not held at; empty when every one is held at all six. */
export function unheld(ids: readonly string[]): string[] {
  return ids.flatMap((id) => {
    const probe = TASK.probes.find((one) => one.id === id);
    if (probe === undefined) return [`${id}: no probe`];
    const widths = new Set((probe.widths ?? [1480]).map(String));
    return PLACES.filter(
      (at) => !widths.has(at.split('-')[0] ?? '') || pinned.probes[id]?.[at] === undefined,
    ).map((at) => `${id}@${at}`);
  });
}
