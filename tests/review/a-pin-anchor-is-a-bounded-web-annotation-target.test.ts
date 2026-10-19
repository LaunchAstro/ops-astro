// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one table of anchors per refusal, read top to bottom */
//
// C35 (#2012): a pin's anchor is a W3C Web Annotation target, its source the revision and its
// selectors a validated union by type: a media fragment `xywh` on one width's capture, and a
// text quote when one is under the spot. Each malformed anchor is refused naming its operand,
// and nothing past the capture, an unknown selector type or an unbounded quote is kept.

import { describe, expect, it } from 'vitest';
import { MOST_CAPTURE_HEIGHT, parseAnchor } from '../../packages/core-records/src/review/anchor.ts';

const REVISION = '7d3c1a52-8f0e-4c8b-9a51-0b2f6e4d9c10';
const MEDIA_FRAGMENTS = 'http://www.w3.org/TR/media-frags/';
const fragment = (value: string) => ({
  type: 'FragmentSelector',
  conformsTo: MEDIA_FRAGMENTS,
  value,
});
const quote = { type: 'TextQuoteSelector', exact: 'Book a visit', prefix: 'Today: ' };

const named = (sent: Readonly<Record<string, unknown>>) => {
  const parsed = parseAnchor({ revisionId: REVISION, width: 1480, ...sent });
  return parsed.ok ? 'kept' : parsed.names;
};

describe('C35 a pin anchor', () => {
  it('C35 a pin reads back as a Web Annotation target: source, selector and quote as written', () => {
    const selector = [fragment('xywh=120,340,300,48'), quote];
    expect(parseAnchor({ revisionId: REVISION, width: 1480, selector })).toStrictEqual({
      ok: true,
      anchor: { source: REVISION, width: 1480, selector },
    });
    expect(
      parseAnchor({
        revisionId: REVISION,
        width: 390,
        selector: [fragment('xywh=pixel:0,0,390,1')],
      }),
    ).toStrictEqual({
      ok: true,
      anchor: { source: REVISION, width: 390, selector: [fragment('xywh=pixel:0,0,390,1')] },
    });
  });

  it('a spot off the capture is refused naming selector', () => {
    expect(named({ selector: [fragment('xywh=1400,0,81,10')] })).toStrictEqual(['selector']);
    expect(named({ width: 390, selector: [fragment('xywh=0,0,391,10')] })).toStrictEqual([
      'selector',
    ]);
    expect(
      named({ selector: [fragment(`xywh=0,${MOST_CAPTURE_HEIGHT - 9},10,10`)] }),
    ).toStrictEqual(['selector']);
    expect(named({ selector: [fragment('xywh=0,0,0,10')] })).toStrictEqual(['selector']);
    expect(named({ selector: [fragment('xywh=-1,0,10,10')] })).toStrictEqual(['selector']);
    expect(named({ selector: [fragment('xywh=percent:0,0,10,10')] })).toStrictEqual(['selector']);
    expect(named({ selector: [fragment('xywh=1,2,3')] })).toStrictEqual(['selector']);
    expect(named({ selector: [fragment('xywh=1,2,3,4 ')] })).toStrictEqual(['selector']);
    expect(named({ selector: [fragment('XYWH=1,2,3,4')] })).toStrictEqual(['selector']);
  });

  it('a width that is not a capture width is refused naming width', () => {
    for (const width of [900, 0, '1480', 1480.5, null]) {
      expect(named({ width, selector: [fragment('xywh=0,0,10,10')] })).toStrictEqual(['width']);
    }
  });

  it('a revision that is not an identifier is refused naming revisionId', () => {
    for (const revisionId of ['', 'rev-1', 42, undefined]) {
      expect(
        parseAnchor({ revisionId, width: 1480, selector: [fragment('xywh=0,0,10,10')] }),
      ).toStrictEqual({ ok: false, names: ['revisionId'] });
    }
  });

  it('the selector set is a closed union today, judged by type, with one fragment', () => {
    const spot = fragment('xywh=0,0,10,10');
    const refusedSelectors: readonly unknown[] = [
      undefined,
      [],
      spot,
      [quote],
      [spot, spot],
      [spot, quote, quote],
      [{ ...spot, type: 'CssSelector' }],
      [{ ...spot, conformsTo: 'http://www.w3.org/TR/media-frags' }],
      [{ ...spot, extra: true }],
      [spot, { ...quote, exact: '' }],
      [spot, { ...quote, exact: 'x'.repeat(1025) }],
      [spot, { ...quote, prefix: 'x'.repeat(257) }],
      [spot, { ...quote, suffix: 7 }],
      [spot, { ...quote, exact: 'a\u0000b' }],
      [spot, { ...quote, exact: 'a\uD800b' }],
      [spot, { ...quote, refinedBy: {} }],
      ['xywh=0,0,10,10'],
    ];
    for (const selector of refusedSelectors) {
      expect(named({ selector })).toStrictEqual(['selector']);
    }
  });

  it('the anchor keeps no field the caller adds beside the selectors', () => {
    const parsed = parseAnchor({
      revisionId: REVISION.toUpperCase(),
      width: 1480,
      selector: [fragment('xywh=0,0,10,10')],
      source: 'https://elsewhere.example/',
    });
    expect(parsed).toStrictEqual({
      ok: true,
      anchor: { source: REVISION, width: 1480, selector: [fragment('xywh=0,0,10,10')] },
    });
  });
});
