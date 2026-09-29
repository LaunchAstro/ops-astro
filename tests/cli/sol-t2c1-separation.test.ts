// SPDX-License-Identifier: AGPL-3.0-only
// Review proof: T2c1's new served dispatch route must exercise every named
// data-separation boundary that it touches.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./t2c1-dispatch-surfaces.test.ts', import.meta.url), 'utf8');

function caseBody(name: string): string {
  const start = source.indexOf(`it('${name}'`);
  if (start < 0) return '';
  const end = source.indexOf('\n  it(', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

describe('T2c1 dispatch separation coverage', () => {
  it('Sol proof, criterion 3: served dispatch tests cross client and person boundaries by name', () => {
    for (const name of [
      'T2 isolation: client to client, task.dispatch',
      'T2 isolation: person to person, task.dispatch',
    ]) {
      const body = caseBody(name);
      expect(body, name).not.toBe('');
      expect(body, name).toMatch(/httpDispatch\(|fetch\(/u);
      expect(body, name).toMatch(/marked\(/u);
      expect(body, name).toMatch(/refused|status/u);
    }
  });
});
