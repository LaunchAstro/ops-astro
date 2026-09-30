// SPDX-License-Identifier: AGPL-3.0-only
//
// The page kit's bar list, the meter as a page part and the legend. The meter
// places the kit's meter (DS-PRIM-23) and adds only its label and value line;
// the bar list and legend are page-level parts the kit does not draw.

import type { ReactElement } from 'react';
import { Meter } from '../kit/blocks.tsx';

export interface Bar {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  /** What the value column shows; the value as a figure when absent. */
  readonly display?: string | undefined;
}

const figure = (value: number): string => value.toLocaleString('en-AU');

/** A share of a whole as a width: 0 to 100, one decimal, never NaN. */
function share(value: number, whole: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (value / whole) * 100)) * 10) / 10;
}

/** Each bar's width against `of`, or against the largest value when absent. */
export function barShares(bars: readonly Bar[], of?: number): readonly number[] {
  const whole =
    of ??
    bars.reduce(
      (largest, bar) => (Number.isFinite(bar.value) ? Math.max(largest, bar.value) : largest),
      0,
    );
  return bars.map((bar) => share(bar.value, whole));
}

export function BarList(props: {
  readonly label: string;
  readonly bars: readonly Bar[];
  readonly of?: number | undefined;
}): ReactElement {
  const shares = barShares(props.bars, props.of);
  return (
    <ul className="barlist" aria-label={props.label}>
      {props.bars.map((bar, index) => (
        <li key={bar.id} className="barlist__row">
          <span className="barlist__label">{bar.label}</span>
          <span className="barlist__track" aria-hidden="true">
            <span className="barlist__fill" style={{ width: `${String(shares[index] ?? 0)}%` }} />
          </span>
          <span className="barlist__val">{bar.display ?? figure(bar.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export interface PageMeterProps {
  readonly label: string;
  readonly value: number;
  /** The whole; without a positive one there is no bar to draw. */
  readonly max: number;
  /** Drawn as a line across the bar. */
  readonly target?: number | undefined;
  readonly tone?: 'ok' | 'warn' | 'bad' | undefined;
  /** How the value reads; the value as a figure when absent. */
  readonly display?: string | undefined;
}

export function PageMeter(props: PageMeterProps): ReactElement {
  const drawn = Number.isFinite(props.max) && props.max > 0;
  const value = props.display ?? figure(props.value);
  return (
    <div className="pmeter">
      <div className="pmeter__line">
        <span className="pmeter__label">{props.label}</span>
        <span className="pmeter__val">{drawn ? `${value} of ${figure(props.max)}` : value}</span>
      </div>
      {drawn ? (
        <Meter
          label={props.label}
          value={props.value}
          max={props.max}
          target={props.target}
          tone={props.tone}
        />
      ) : null}
    </div>
  );
}

export interface LegendItem {
  readonly id: string;
  readonly label: string;
  readonly tone: 'ink' | 'accent' | 'muted' | 'success' | 'warning' | 'danger';
}

/** Names each series in words; the colour key beside it is decoration. */
export function Legend(props: {
  readonly label: string;
  readonly items: readonly LegendItem[];
}): ReactElement | null {
  if (props.items.length === 0) return null;
  return (
    <ul className="legend" aria-label={props.label}>
      {props.items.map((item) => (
        <li key={item.id}>
          <span className={`legend__key legend__key--${item.tone}`} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
