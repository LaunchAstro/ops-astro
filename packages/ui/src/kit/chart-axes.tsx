// SPDX-License-Identifier: AGPL-3.0-only
//
// The axes the line and column charts share (MP-1-5): the plot's box, each
// axis's ticks and scale, and the gridlines and labels drawn from them. A
// second quantity gets its own labelled right-hand axis (R58).

import type { ReactElement } from 'react';
import { axisTicks, formatTick, type ChartUnit, type Series } from './chart-numbers.ts';

// `titled` is the top when two axes carry their titles above the plot.
const PAD = { top: 14, titled: 30, bottom: 26, left: 44, right: 14, second: 48 } as const;

export interface Plot {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The plot's box in a chart this wide and tall, room made above and right for a second axis. */
export function plotOf(width: number, height: number, second: boolean): Plot {
  const top = second ? PAD.titled : PAD.top;
  return {
    x: PAD.left,
    y: top,
    w: Math.max(0, width - PAD.left - (second ? PAD.second : PAD.right)),
    h: height - top - PAD.bottom,
  };
}

export interface Axis {
  readonly ticks: readonly number[];
  readonly unit: ChartUnit;
  readonly label: string;
  /** The y of a value on this axis. */
  readonly y: (value: number) => number;
}

export function axisFor(
  series: readonly Series[],
  top: number,
  height: number,
  stacked = false,
): Axis | null {
  const first = series[0];
  if (first === undefined) return null;
  const values = stacked
    ? first.values.map((_, i) => series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0))
    : series.flatMap((s) => s.values);
  const unit = first.unit ?? 'number';
  const ticks = axisTicks(Math.min(0, ...values), Math.max(0, ...values), {
    integer: unit === 'count',
  });
  const lo = ticks[0] ?? 0;
  const hi = ticks.at(-1) ?? 1;
  return {
    ticks,
    unit,
    label: first.label,
    y: (value) => top + height - ((value - lo) / (hi - lo)) * height,
  };
}

function LeftTicks(props: { readonly axis: Axis; readonly plot: Plot }): ReactElement {
  const { axis, plot } = props;
  return (
    <>
      {axis.ticks.map((tick) => (
        <g key={tick}>
          <line
            className="chart__grid"
            x1={plot.x}
            x2={plot.x + plot.w}
            y1={axis.y(tick)}
            y2={axis.y(tick)}
          />
          <text
            className="chart__axis chart__axis--y"
            x={plot.x - 8}
            y={axis.y(tick) + 3.5}
            textAnchor="end"
          >
            {formatTick(tick, axis.ticks, axis.unit)}
          </text>
        </g>
      ))}
    </>
  );
}

function RightTicks(props: { readonly axis: Axis; readonly plot: Plot }): ReactElement {
  const { axis, plot } = props;
  return (
    <>
      {axis.ticks.map((tick) => (
        <text
          key={tick}
          className="chart__axis chart__axis--right"
          x={plot.x + plot.w + 8}
          y={axis.y(tick) + 3.5}
          textAnchor="start"
        >
          {formatTick(tick, axis.ticks, axis.unit)}
        </text>
      ))}
    </>
  );
}

/** Both axes' titles above the plot, drawn only when there are two axes. */
function AxisTitles(props: {
  readonly left: Axis;
  readonly right: Axis;
  readonly plot: Plot;
}): ReactElement {
  return (
    <>
      <text className="chart__axis-title chart__axis-title--left" x={0} y={10} textAnchor="start">
        {props.left.label}
      </text>
      <text
        className="chart__axis-title chart__axis-title--right"
        x={props.plot.x + props.plot.w + PAD.second}
        y={10}
        textAnchor="end"
      >
        {props.right.label}
      </text>
    </>
  );
}

/** Gridlines and labels for the left axis, the right axis if there is one, and the x labels. */
export function Axes(props: {
  readonly left: Axis;
  readonly right: Axis | null;
  readonly plot: Plot;
  readonly labels: readonly string[];
  readonly xOf: (index: number) => number;
  readonly bottom: number;
}): ReactElement {
  const { left, right, plot } = props;
  const every = Math.max(1, Math.ceil(props.labels.length / Math.max(2, Math.floor(plot.w / 56))));
  return (
    <g aria-hidden="true">
      <LeftTicks axis={left} plot={plot} />
      {right !== null && <RightTicks axis={right} plot={plot} />}
      {right !== null && <AxisTitles left={left} right={right} plot={plot} />}
      {props.labels.map((label, i) =>
        i % every === 0 || i === props.labels.length - 1 ? (
          <text
            key={label}
            className="chart__axis chart__axis--x"
            x={props.xOf(i)}
            y={props.bottom - 7}
            textAnchor="middle"
          >
            {label}
          </text>
        ) : null,
      )}
    </g>
  );
}

/** The plot's ground and its axes, the first things an axis chart draws. */
export function PlotAxes(props: {
  readonly left: Axis;
  readonly right: Axis | null;
  readonly plot: Plot;
  readonly labels: readonly string[];
  readonly xOf: (index: number) => number;
  readonly bottom: number;
}): ReactElement {
  const { plot } = props;
  return (
    <>
      <rect className="chart__plot" x={plot.x} y={plot.y} width={plot.w} height={plot.h} />
      <Axes {...props} />
    </>
  );
}
