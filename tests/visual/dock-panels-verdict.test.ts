// SPDX-License-Identifier: AGPL-3.0-only
//
// The local dock-panel comparison's verdict (dock-panels-mockup.ts): a pair
// measured alike passes, and a planted difference in a part's box or style,
// or a part one side does not draw, is named by part, property and both values.

import { expect, it } from 'vitest';
import { verdictOf, type Measured, type Parts } from './dock-panels-parts.ts';

const STYLE = {
  font: 'Funnel Sans',
  size: '13px',
  weight: '400',
  lh: '20.15px',
  ls: 'normal',
  tt: 'none',
  color: '#000000',
  bg: 'none',
  border: 'none',
  borderColor: 'none',
  radius: '0px',
  pad: '4px 12px',
  gap: 'normal',
  display: 'flex',
};
const part = (box: Measured['box'], style: Partial<typeof STYLE> = {}): Measured => ({
  box,
  style: { ...STYLE, ...style },
});
const PANEL: Parts = {
  panel: part([930, 45, 550, 955]),
  head: part([931, 45, 549, 59], { pad: '16px 16px 16px 24px' }),
  row: part([955, 238, 501, 47]),
  empty: null,
};

it('passes a pair measured alike', () => {
  expect(verdictOf(PANEL, structuredClone(PANEL))).toEqual([]);
});

it('names a planted style difference by part, property and both values', () => {
  const built = { ...PANEL, row: part([955, 238, 501, 47], { size: '14px' }) };
  expect(verdictOf(PANEL, built)).toEqual([
    { part: 'row', property: 'size', mockup: '13px', built: '14px' },
  ]);
});

it("names a planted box difference, and a part's place within its panel", () => {
  const built = { ...PANEL, head: part([941, 45, 520, 59], { pad: '16px 16px 16px 24px' }) };
  expect(verdictOf(PANEL, built)).toEqual([
    { part: 'head', property: 'width', mockup: '549px', built: '520px' },
    { part: 'head', property: 'left', mockup: '1px', built: '11px' },
  ]);
});

it('holds a box within a pixel', () => {
  const built = { ...PANEL, row: part([956, 239, 502, 48]) };
  expect(verdictOf(PANEL, built)).toEqual([]);
});

it('names a part one side does not draw', () => {
  const built = { ...PANEL, row: null, empty: part([955, 238, 501, 30]) };
  expect(verdictOf(PANEL, built)).toEqual([
    { part: 'row', property: 'present', mockup: 'drawn', built: 'absent' },
    { part: 'empty', property: 'present', mockup: 'absent', built: 'drawn' },
  ]);
});
