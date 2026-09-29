// SPDX-License-Identifier: AGPL-3.0-only
//
// The inline charts (MP-1-5): DS-COMP-29's sparkline, sized by its host, and
// DS-COMP-40's true-scale funnel.

import type { CSSProperties, ReactElement } from 'react';
import {
  formatValue,
  pathOf,
  share,
  trim,
  type ChartTone,
  type FunnelStep,
} from './chart-numbers.ts';

/** DS-COMP-29 `sparkline`: a small line with its area and an end dot, sized by its host. */
export function Sparkline(props: {
  readonly name: string;
  readonly values: readonly number[];
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly tone?: ChartTone | undefined;
}): ReactElement {
  const w = props.width ?? 120;
  const h = props.height ?? 30;
  const values = props.values;
  const lo = Math.min(0, ...values);
  const hi = Math.max(1, ...values);
  const y = (v: number): number => h - 3 - ((v - lo) / (hi - lo || 1)) * (h - 6);
  const x = (i: number): number => (values.length === 1 ? w / 2 : (i / (values.length - 1)) * w);
  const pts = values.map((v, i) => [x(i), y(v)] as const);
  const line = pathOf(pts);
  const end = pts.at(-1);
  const last = values.at(-1);
  return (
    <svg
      className="spark"
      data-tone={props.tone ?? 'accent'}
      viewBox={`0 0 ${String(w)} ${String(h)}`}
      width={w}
      height={h}
      role="img"
      aria-label={
        last === undefined
          ? `${props.name}: no values`
          : `${props.name}: latest ${formatValue(last)}`
      }
    >
      {pts.length > 1 && (
        <path className="chart__area" d={`${line} L${String(w)},${String(h)} L0,${String(h)} Z`} />
      )}
      <path className="chart__line" d={line} />
      {end !== undefined && (
        <circle className="chart__end" cx={trim(end[0], 1)} cy={trim(end[1], 1)} r={2.2} />
      )}
    </svg>
  );
}

/** One funnel stage: its label, its shape from this width to the next, its count and its conversion. */
function FunnelRow(props: {
  readonly step: FunnelStep;
  readonly real: readonly FunnelStep[];
  readonly width: (count: number) => number;
}): ReactElement {
  const { step, real, width } = props;
  const at = real.indexOf(step);
  const next = real[at + 1];
  const previous = at > 0 ? real[at - 1] : undefined;
  // Stepped accent tints, 12% at the top to 56% at the bottom; a context row 6%.
  const depth =
    step.context === true ? 0.06 : 0.12 + (real.length > 1 ? (0.44 * at) / (real.length - 1) : 0);
  const style = {
    '--w': `${trim(step.context === true ? 100 : width(step.count), 2)}%`,
    '--next': `${trim(step.context === true || next === undefined ? width(step.count) : width(next.count), 2)}%`,
    '--depth': trim(depth, 3),
  } as CSSProperties;
  return (
    <div className={`funnel__step${step.context === true ? ' funnel__step--ctx' : ''}`}>
      <span className="funnel__label">{step.label}</span>
      <span className="funnel__shape" aria-hidden="true">
        <span className="funnel__bg" style={style} />
      </span>
      <span className="funnel__val">
        {formatValue(step.count)}
        {previous !== undefined && (
          <span className="funnel__pct">{share(step.count, previous.count)}</span>
        )}
      </span>
    </div>
  );
}

/**
 * DS-COMP-40: a conversion funnel to true scale. Each stage is as wide as its
 * count against the first stage below any context rows, with its conversion
 * from the stage before and the end-to-end rate beneath.
 */
export function Funnel(props: {
  readonly name: string;
  readonly steps: readonly FunnelStep[];
  readonly look?: 'shape' | 'bars' | undefined;
}): ReactElement {
  const real = props.steps.filter((s) => s.context !== true);
  const first = real[0]?.count ?? 0;
  const last = real.at(-1);
  const width = (count: number): number => (first === 0 ? 0 : (count / first) * 100);
  return (
    <div className={`funnel funnel--${props.look ?? 'shape'}`} role="group" aria-label={props.name}>
      {props.steps.map((step) => (
        <FunnelRow key={step.label} step={step} real={real} width={width} />
      ))}
      {last !== undefined && real.length > 1 && (
        <p className="funnel__foot">
          {share(last.count, first)} end to end, {real[0]?.label.toLowerCase()} to{' '}
          {last.label.toLowerCase()}
        </p>
      )}
    </div>
  );
}
