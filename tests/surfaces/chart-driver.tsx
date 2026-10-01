// SPDX-License-Identifier: AGPL-3.0-only
//
// Drives the chart primitives in jsdom the way a person does (MP-1-5): jsdom
// has no ResizeObserver, so a stand-in records the observers and a test
// reports sizes through them; the pointer enters and leaves a point; the
// keyboard focuses a chart and presses keys. With the sample series the chart
// tests share.

import { act } from 'react';
import { beforeEach } from 'vitest';
import { axisTicks, formatTick } from '../../packages/ui/src/kit/charts.tsx';

/** The browser's ResizeObserver, stood in: every observer and what it watches. */
export class Observer {
  static live: Observer[] = [];
  readonly watched: Element[] = [];
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    Observer.live.push(this);
  }
  observe(target: Element): void {
    this.watched.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    Observer.live = Observer.live.filter((o) => o !== this);
  }
  report(width: number): void {
    const entries = this.watched.map(
      (target) => ({ target, contentRect: { width, height: 0 } }) as unknown as ResizeObserverEntry,
    );
    this.callback(entries, this as unknown as ResizeObserver);
  }
}
/** Tell every live observer its element is now `width` wide, the way a show or a resize does. */
export const resize = async (width: number): Promise<void> => {
  await act(() => {
    for (const observer of Observer.live) observer.report(width);
  });
};

/** Installs the stand-in before each test, with no observer left from the last. */
export function standInResizeObserver(): void {
  beforeEach(() => {
    Observer.live = [];
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Observer;
  });
}

export const DAYS = ['Mon 1', 'Tue 2', 'Wed 3', 'Thu 4', 'Fri 5'];
export const money = { label: 'Spend', values: [120, 80, 140, 60, 100], unit: 'money' } as const;
export const enquiries = {
  label: 'Genuine enquiries',
  values: [1, 0, 2, 1, 3],
  unit: 'count',
  axis: 'right',
} as const;

export const hover = async (target: Element | null | undefined): Promise<void> => {
  if (target === null || target === undefined) throw new Error('nothing to hover');
  await act(() => {
    target.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }),
    );
  });
};
export const leave = async (target: Element | null | undefined): Promise<void> => {
  if (target === null || target === undefined) throw new Error('nothing to leave');
  await act(() => {
    target.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
    );
  });
};
export const key = async (target: Element | null, name: string): Promise<void> => {
  await act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
};
export const focus = async (target: Element | null | undefined): Promise<void> => {
  await act(() => {
    (target as SVGElement | null)?.focus();
  });
};
/** The x of a path's last point. */
export const lastX = (d: string): number => Number(/([\d.]+),[\d.]+$/u.exec(d)?.[1]);
/** An axis from zero to `max`, as its labels read. */
export const labelled = (max: number, integer = false): readonly string[] => {
  const ticks = axisTicks(0, max, { integer });
  return ticks.map((t) => formatTick(t, ticks));
};
