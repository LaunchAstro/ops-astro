// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, lane FR1-WEB-B: the non-DOM items.
//
// #36/#47  The board's Overdue and Today tones are judged against the viewer's
//          own calendar day, not the UTC one (packages/ui/src/surfaces/Board.tsx
//          :198-205; apps/web/src/screens/task/DetailsForm.tsx:59-67).
// #43      Layer 6 reads only tokens layer 1 declares and overrides no ported
//          rule (apps/web/src/styles/6-slice.css:9-14).
// #48      The web comments describe the two-code door (docs/local/WEB.md:40-48).

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dueTone } from '../../apps/web/src/screens/Projects.tsx';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('FR1-WEB-B #36/#47: dueTone in the viewer’s day', () => {
  let tz: string | undefined;
  beforeEach(() => {
    tz = process.env['TZ'];
  });
  afterEach(() => {
    if (tz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = tz;
  });

  it('08:00 in Brisbane on the 25th: the 24th is overdue and the 25th is today', () => {
    process.env['TZ'] = 'Australia/Brisbane';
    const now = new Date('2026-09-24T22:00:00Z');
    expect(dueTone('2026-09-24T00:00:00.000Z', now)).toBe('past');
    expect(dueTone('2026-09-25T00:00:00.000Z', now)).toBe('today');
    expect(dueTone('2026-09-26T00:00:00.000Z', now)).toBe('later');
  });

  it('22:00 in Sydney on the 24th: the 24th is today', () => {
    process.env['TZ'] = 'Australia/Sydney';
    const now = new Date('2026-09-24T12:00:00Z');
    expect(dueTone('2026-09-24T00:00:00.000Z', now)).toBe('today');
    expect(dueTone('2026-09-23T00:00:00.000Z', now)).toBe('past');
  });

  it('no due date is no tone', () => {
    expect(dueTone(null, new Date())).toBeNull();
  });
});

describe('FR1-WEB-B #43: layer 6 borrows layer 1 and overrides nothing ported', () => {
  const slice = read('apps/web/src/styles/6-slice.css');
  const tokens = new Set(
    [...read('packages/ui/src/styles/1-tokens.css').matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(
      (match) => match[1],
    ),
  );

  it('every var() in 6-slice.css names a layer 1 token, with no literal fallback', () => {
    const used = [...slice.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,[^)]*)?\)/g)];
    expect(used.length).toBeGreaterThan(0);
    const undefinedNames = [...new Set(used.map((m) => m[1]).filter((n) => !tokens.has(n)))];
    expect(undefinedNames).toEqual([]);
    const withFallback = used.filter((m) => m[2] !== undefined).map((m) => m[0]);
    expect(withFallback).toEqual([]);
  });

  it('redefines none of the button rules layer 2 owns', () => {
    const selectors = [...slice.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
      .flatMap((m) => (m[1] ?? '').split(','))
      .map((s) => s.trim());
    expect(selectors.filter((s) => /(^|\s)\.btn(\b|--|\[|:)/.test(s))).toEqual([]);
  });
});

describe('FR1-WEB-B #48: the web comments describe the two-code door', () => {
  it('no comment says the API cannot tell an expired bearer apart', () => {
    for (const path of ['apps/web/src/screens/SignIn.tsx', 'apps/web/src/session/token.ts']) {
      const text = read(path).replace(/\s+/g, ' ');
      expect(text).not.toMatch(/cannot tell an expired/u);
      expect(text).not.toMatch(/expiry is a guess/u);
      expect(text).not.toMatch(/an expired and an unverifiable bearer/u);
      expect(text).toMatch(/AUTH_SESSION_EXPIRED/u);
    }
  });
});
