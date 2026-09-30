// SPDX-License-Identifier: AGPL-3.0-only
//
// DS-COMP-27 `column` (MP-1-5): grouped or stacked bars per label, with an
// optional dashed line series on top, on its own right-hand axis when it is a
// second quantity (R58).

import type { ReactElement } from 'react';
import { PlotAxes, axisFor, plotOf, type Axis, type Plot } from './chart-axes.tsx';
import {
  Frame,
  HitTargets,
  Tooltip,
  usePoints,
  useWidth,
  type AxisChartProps,
  type Tip,
} from './chart-frame.tsx';
import { pathOf, rowsAt, toneOf, type Series } from './chart-numbers.ts';

/** One label's bars, grouped side by side or stacked, each from its base to its value. */
function Bars(props: {
  readonly bars: readonly Series[];
  readonly index: number;
  readonly axis: Axis;
  readonly x: number;
  readonly bar: number;
  readonly stacked: boolean;
  readonly active: boolean;
}): ReactElement {
  const { axis, bar, stacked } = props;
  const group = bar / props.bars.length;
  let below = 0;
  return (
    <g aria-hidden="true" className={props.active ? 'is-active' : undefined}>
      {props.bars.map((s, k) => {
        const v = s.values[props.index] ?? 0;
        const [x, w] = stacked
          ? [props.x - bar / 2, bar]
          : [props.x - bar / 2 + group * k, Math.max(1, group - 1.5)];
        const [from, to] = stacked ? [below, below + v] : [0, v];
        below += stacked ? v : 0;
        return (
          <rect
            key={s.label}
            className="chart__bar"
            data-tone={toneOf(s.tone, k)}
            x={x}
            y={Math.min(axis.y(from), axis.y(to))}
            width={w}
            height={Math.abs(axis.y(to) - axis.y(from)) || (from === to ? 0 : 1)}
          />
        );
      })}
    </g>
  );
}

/** The dashed line series over the bars, with a dot at each value. */
function DashedLine(props: {
  readonly line: Series;
  readonly tone: number;
  readonly axis: Axis;
  readonly labels: readonly string[];
  readonly xOf: (index: number) => number;
}): ReactElement {
  const values = props.line.values.slice(0, props.labels.length);
  return (
    <g data-tone={toneOf(props.line.tone, props.tone)} aria-hidden="true">
      <path
        className="chart__line"
        d={pathOf(values.map((v, i) => [props.xOf(i), props.axis.y(v)] as const))}
        strokeDasharray="4 3"
      />
      {values.map((v, i) => (
        <circle
          key={props.labels[i] ?? i}
          className="chart__dot"
          cx={props.xOf(i)}
          cy={props.axis.y(v)}
          r={2.4}
        />
      ))}
    </g>
  );
}

interface ColumnProps extends AxisChartProps {
  readonly bars: readonly Series[];
  readonly line?: Series | undefined;
  readonly stacked?: boolean | undefined;
}

interface ColumnGeometry {
  readonly plot: Plot;
  readonly left: Axis | null;
  readonly right: Axis | null;
  readonly slot: number;
  readonly xOf: (index: number) => number;
}

/** Where a column chart draws: its plot, its axes and each label's slot. */
function columnGeometry(props: ColumnProps, width: number, height: number): ColumnGeometry {
  const line = props.line;
  const onRight = line?.axis === 'right';
  const plot = plotOf(width, height, onRight);
  const onLeft = line !== undefined && !onRight ? [...props.bars, line] : props.bars;
  const slot = props.labels.length === 0 ? 0 : plot.w / props.labels.length;
  return {
    plot,
    left: axisFor(onLeft, plot.y, plot.h, props.stacked === true),
    right: line !== undefined && onRight ? axisFor([line], plot.y, plot.h) : null,
    slot,
    xOf: (i) => plot.x + slot * i + slot / 2,
  };
}

/** The drawn plot: ground and axes, each label's bars, the dashed line, the hit targets. */
function ColumnPlot(props: {
  readonly at: ColumnGeometry & { readonly left: Axis };
  readonly chart: ColumnProps;
  readonly height: number;
  readonly shown: number | null;
  readonly hit: (index: number) => Record<string, unknown>;
}): ReactElement {
  const { plot, left, right, slot, xOf } = props.at;
  const { chart } = props;
  const base = left.y(0);
  return (
    <>
      <PlotAxes
        left={left}
        right={right}
        plot={plot}
        labels={chart.labels}
        xOf={xOf}
        bottom={props.height}
      />
      {chart.labels.map((label, i) => (
        <Bars
          key={label}
          bars={chart.bars}
          index={i}
          axis={left}
          x={xOf(i)}
          bar={Math.min(26, slot * 0.62)}
          stacked={chart.stacked === true}
          active={props.shown === i}
        />
      ))}
      {chart.line !== undefined && (
        <DashedLine
          line={chart.line}
          tone={chart.bars.length}
          axis={right ?? left}
          labels={chart.labels}
          xOf={xOf}
        />
      )}
      <HitTargets
        labels={chart.labels}
        y={plot.y}
        box={(i) => ({ x: plot.x + slot * i, width: slot, height: Math.max(0, base - plot.y) })}
        hit={props.hit}
      />
    </>
  );
}

/** DS-COMP-27 `column`: grouped bars per label, with an optional dashed line series on top. */
export function ColumnChart(props: ColumnProps): ReactElement {
  const height = props.height ?? 220;
  const [holder, width] = useWidth();
  const points = usePoints(props.labels.length);
  const at = columnGeometry(props, width, height);
  const all = props.line === undefined ? props.bars : [...props.bars, props.line];
  const tipAt = (i: number): Tip => ({
    title: props.labels[i] ?? '',
    rows: rowsAt(all, i),
    x: at.xOf(i),
    y: at.plot.y,
  });
  const shown = points.shown;
  const left = at.left;
  const tip =
    shown === null || width === 0 ? null : <Tooltip id={points.tipId} tip={tipAt(shown)} />;
  return (
    <Frame name={props.name} holder={holder} height={height} width={width} tip={tip}>
      {left === null ? (
        <g />
      ) : (
        <ColumnPlot
          at={{ ...at, left }}
          chart={props}
          height={height}
          shown={shown}
          hit={(i) => points.props(i, tipAt(i))}
        />
      )}
    </Frame>
  );
}
