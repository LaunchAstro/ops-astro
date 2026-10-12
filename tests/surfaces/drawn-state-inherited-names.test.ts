// SPDX-License-Identifier: AGPL-3.0-only
//
// A stored state, wait reason or pinned word is text from outside, so a name
// an object inherits (`__proto__`, `toString`, `constructor`) is a name the
// tables do not know. It prints raw at the waiting tone like any other
// unknown name, never as whatever the object prototype holds under it.

import { describe, expect, it } from 'vitest';
import {
  drawPinnedRunWord,
  drawPinnedStepWord,
  drawRunState,
  drawStepState,
} from '../../packages/ui/src/state/project.ts';

const INHERITED = ['__proto__', 'toString', 'constructor', 'hasOwnProperty'];

const unknown = (name: string) => ({ word: name, tone: 'wait', reference: 'unknown' });

describe('a drawn state named like an inherited object key', () => {
  it('prints the raw name as an unknown state, at the waiting tone', () => {
    for (const name of INHERITED) {
      expect(
        [
          drawRunState({ state: name, waitReason: null }),
          drawRunState({ state: 'waiting', waitReason: name }),
          drawStepState(name),
          drawPinnedRunWord(name),
          drawPinnedStepWord(name),
        ],
        name,
      ).toStrictEqual(Array.from({ length: 5 }, () => unknown(name)));
    }
  });
});
