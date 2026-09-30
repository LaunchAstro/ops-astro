// SPDX-License-Identifier: AGPL-3.0-only
//
// DS-COMP-27 `line` (MP-1-5): values over time, one line per series, an area
// under the first, a second quantity against its own right-hand axis (R58).

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
import { pathOf, rowsAt, toneOf, trim, type Series } from './chart-numbers.ts';

/** One series: its line, the area under it when it has one, and its dot where a point is shown. */
function LineSeries(props: {
  readonly series: Series;
  readonly index: number;
  readonly axis: Axis;
  readonly plot: Plot;
  readonly count: number;
  readonly xOf: (index: number) => number;
  readonly shown: number | null;
}): ReactElement {
  const { series: s, plot, xOf, shown } = props;
  const pts = s.values.slice(0, props.count).map((v, i) => [xOf(i), props.axis.y(v)] as const);
  const line = pathOf(pts);
  return (
    <g data-tone={toneOf(s.tone, props.index)} aria-hidden="true">
      {(s.area ?? props.index === 0) && pts.length > 1 && (
        <path
          className="chart__area"
          d={`${line} L${trim(xOf(pts.length - 1), 1)},${trim(plot.y + plot.h, 1)} L${trim(plot.x, 1)},${trim(plot.y + plot.h, 1)} Z`}
        />
      )}
      <path
        className="chart__line"
        d={line}
        strokeDasharray={s.dashed === true ? '4 3' : undefined}
      />
      {(pts.length === 1 || shown !== null) &&
        pts
          .filter((_, i) => pts.length === 1 || i === shown)
          .map(([x, y]) => <circle key={x} className="chart__dot" cx={x} cy={y} r={3} />)}
    </g>
  );
}

interface LineGeometry {
  readonly plot: Plot;
  readonly left: Axis | null;
  readonly right: Axis | null;
  readonly xOf: (index: number) => number;
  readonly slot: number;
}

/** Where a line chart draws: its plot, its axes and the x of each point. */
function lineGeometry(
  series: readonly Series[],
  count: number,
  width: number,
  height: number,
): LineGeometry {
  const rightSeries = series.filter((s) => s.axis === 'right');
  const plot = plotOf(width, height, rightSeries.length > 0);
  return {
    plot,
    left: axisFor(
      series.filter((s) => s.axis !== 'right'),
      plot.y,
      plot.h,
    ),
    right: axisFor(rightSeries, plot.y, plot.h),
    xOf: (i) => plot.x + (count === 1 ? plot.w / 2 : (i / (count - 1)) * plot.w),
    slot: count === 1 ? plot.w : plot.w / (count - 1),
  };
}

/** The upright line through the shown point. */
function Cursor(props: { readonly x: number; readonly plot: Plot }): ReactElement {
  const { plot } = props;
  return (
    <line className="chart__cursor" x1={props.x} x2={props.x} y1={plot.y} y2={plot.y + plot.h} />
  );
}

/** The drawn plot: ground and axes, the cursor at the shown point, each series, the hit targets. */
function LinePlot(props: {
  readonly at: LineGeometry & { readonly left: Axis };
  readonly series: readonly Series[];
  readonly labels: readonly string[];
  readonly height: number;
  readonly shown: number | null;
  readonly hit: (index: number) => Record<string, unknown>;
}): ReactElement {
  const { plot, left, right, xOf, slot } = props.at;
  const { shown } = props;
  return (
    <>
      <PlotAxes
        left={left}
        right={right}
        plot={plot}
        labels={props.labels}
        xOf={xOf}
        bottom={props.height}
      />
      {shown !== null && <Cursor x={xOf(shown)} plot={plot} />}
      {props.series.map((s, k) => (
        <LineSeries
          key={s.label}
          series={s}
          index={k}
          axis={s.axis === 'right' && right !== null ? right : left}
          plot={plot}
          count={props.labels.length}
          xOf={xOf}
          shown={shown}
        />
      ))}
      <HitTargets
        labels={props.labels}
        y={plot.y}
        box={(i) => ({
          x: Math.max(plot.x, xOf(i) - slot / 2),
          width: Math.min(slot, plot.w),
          height: plot.h,
        })}
        hit={props.hit}
      />
    </>
  );
}

/** DS-COMP-27 `line`: values over time, one line per series, an area under the first. */
export function LineChart(
  props: AxisChartProps & { readonly series: readonly Series[] },
): ReactElement {
  const height = props.height ?? 240;
  const [holder, width] = useWidth();
  const points = usePoints(props.labels.length);
  const at = lineGeometry(props.series, props.labels.length, width, height);
  const tipAt = (i: number): Tip => ({
    title: props.labels[i] ?? '',
    rows: rowsAt(props.series, i),
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
        <LinePlot
          at={{ ...at, left }}
          series={props.series}
          labels={props.labels}
          height={height}
          shown={shown}
          hit={(i) => points.props(i, tipAt(i))}
        />
      )}
    </Frame>
  );
}
