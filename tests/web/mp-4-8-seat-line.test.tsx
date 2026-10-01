// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 seat line (T-D19, owner answer 8): the dock task panel seats only
// when `n × per ≤ vw − rail − 40 − 836` allows, otherwise floats at the width
// asked for, never under 380; a sheet at 900, a bottom sheet at 390. The frame
// facts (the rail's state, the panels open, the width asked for) are the dock
// frame's (MP-3-1); until it joins, a made-up source stands behind the same
// interface and the placement carries the one Mock corner label.

import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DockSeat } from '../../apps/web/src/screens/task/DockSeat.tsx';
import type { FrameFacts, FrameFactsSource } from '../../apps/web/src/screens/task/frame-seam.ts';
import { seatFor } from '../../apps/web/src/screens/task/seat-line.ts';
import { mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const facts = (over: Partial<FrameFacts> = {}): FrameFacts => ({
  viewport: 1700,
  railExpanded: true,
  panels: 1,
  asked: 550,
  ...over,
});

describe('MP-4-8 seat line', () => {
  it('seats one 550 panel from 1650 with the expanded rail, and floats at 1649', () => {
    expect(seatFor(facts({ viewport: 1650 }))).toEqual({ placement: 'seated', width: 550 });
    expect(seatFor(facts({ viewport: 1649 }))).toEqual({ placement: 'floating', width: 550 });
  });

  it('seats one 550 panel from 1482 with the rail collapsed, and floats at 1481', () => {
    const collapsed = { railExpanded: false };
    expect(seatFor(facts({ ...collapsed, viewport: 1482 }))).toEqual({
      placement: 'seated',
      width: 550,
    });
    expect(seatFor(facts({ ...collapsed, viewport: 1481 }))).toEqual({
      placement: 'floating',
      width: 550,
    });
  });

  it('counts every open panel at the width asked for against the line', () => {
    expect(seatFor(facts({ viewport: 2200, panels: 2 })).placement).toBe('seated');
    expect(seatFor(facts({ viewport: 2199, panels: 2 })).placement).toBe('floating');
  });
});

describe('MP-4-8 seat line: the floor, 1440 and the sheets', () => {
  it('floats at the width asked for rather than narrowing to fit the line', () => {
    expect(seatFor(facts({ viewport: 1480 }))).toEqual({ placement: 'floating', width: 550 });
  });

  it('never draws a seated or floating panel under 380', () => {
    expect(seatFor(facts({ viewport: 1700, asked: 200 }))).toEqual({
      placement: 'seated',
      width: 380,
    });
    expect(seatFor(facts({ viewport: 1300, asked: 200 }))).toEqual({
      placement: 'floating',
      width: 380,
    });
  });

  it('does not seat under 1440 even where the line would allow it', () => {
    expect(seatFor(facts({ viewport: 1439, railExpanded: false, asked: 380 })).placement).toBe(
      'floating',
    );
    expect(seatFor(facts({ viewport: 1440, railExpanded: false, asked: 380 })).placement).toBe(
      'seated',
    );
  });

  it('is a sheet at 900 and a bottom sheet at 390, full width', () => {
    expect(seatFor(facts({ viewport: 900 }))).toEqual({ placement: 'sheet', width: 900 });
    expect(seatFor(facts({ viewport: 1279 }))).toEqual({ placement: 'sheet', width: 1279 });
    expect(seatFor(facts({ viewport: 390 }))).toEqual({ placement: 'bottom-sheet', width: 390 });
    expect(seatFor(facts({ viewport: 640 })).placement).toBe('bottom-sheet');
    expect(seatFor(facts({ viewport: 641 })).placement).toBe('sheet');
  });
});

const source = (provenance: 'real' | 'mock', over: Partial<FrameFacts> = {}): FrameFactsSource => ({
  provenance,
  useFacts: () => facts(over),
});

const panel = (): ReactElement => <aside className="dtp" data-task-panel aria-label="Task panel" />;

describe('MP-4-8 seat line: the panel takes its place from the rule', () => {
  it('draws the panel seated at its width at 1700', async () => {
    const { host } = await mount(<DockSeat source={source('real')}>{panel()}</DockSeat>);
    const seat = host.querySelector<HTMLElement>('.dtp-seat');
    expect(seat?.dataset['placement']).toBe('seated');
    expect(seat?.style.width).toBe('550px');
    expect(seat?.querySelector('[data-task-panel]')).not.toBeNull();
  });

  it('draws the panel floating at 1480, a sheet at 900 and a bottom sheet at 390', async () => {
    const at = async (viewport: number) => {
      const { host } = await mount(
        <DockSeat source={source('real', { viewport })}>{panel()}</DockSeat>,
      );
      return host.querySelector<HTMLElement>('.dtp-seat')?.dataset['placement'];
    };
    expect(await at(1480)).toBe('floating');
    expect(await at(900)).toBe('sheet');
    expect(await at(390)).toBe('bottom-sheet');
  });

  it('carries the one Mock corner label on a made-up frame, and none on a real one', async () => {
    const mocked = await mount(<DockSeat source={source('mock')}>{panel()}</DockSeat>);
    expect(mocked.host.querySelectorAll('.mocktag')).toHaveLength(1);
    expect(mocked.host.querySelector('.mocktag')?.textContent).toBe('Mock');
    const real = await mount(<DockSeat source={source('real')}>{panel()}</DockSeat>);
    expect(real.host.querySelector('.mocktag')).toBeNull();
  });

  it('draws nothing when no panel is open', async () => {
    const { host } = await mount(<DockSeat source={source('mock')}>{null}</DockSeat>);
    expect(host.querySelector('.dtp-seat')).toBeNull();
    expect(host.querySelector('.mocktag')).toBeNull();
  });
});
