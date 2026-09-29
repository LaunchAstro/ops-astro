// SPDX-License-Identifier: AGPL-3.0-only
//
// DS-COMP-28 radial charts (MP-1-5): the donut with its centre value, the
// semicircle gauge with a target tick, and the score dial in its bands.

import type { ReactElement } from 'react';
import { Tooltip, usePoints, type Tip } from './chart-frame.tsx';
import {
  formatValue,
  fraction,
  polar,
  scoreBand,
  share,
  toneOf,
  trim,
  type ChartTone,
  type ChartUnit,
  type Slice,
} from './chart-numbers.ts';

/** Each slice's ring segment, from the top clockwise, with the tip at its outer middle. */
function arcsOf(
  slices: readonly Slice[],
  r: number,
  inner: number,
  unit: ChartUnit | undefined,
): { readonly slice: Slice; readonly d: string; readonly tip: Tip }[] {
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  let from = -Math.PI / 2;
  return slices.map((slice) => {
    const sweep = total === 0 ? 0 : (Math.max(0, slice.value) / total) * Math.PI * 2;
    const to = from + Math.min(sweep, Math.PI * 2 - 1e-4);
    const big = to - from > Math.PI ? 1 : 0;
    const [x0, y0] = polar(r, r, r, from);
    const [x1, y1] = polar(r, r, r, to);
    const [x2, y2] = polar(r, r, inner, to);
    const [x3, y3] = polar(r, r, inner, from);
    const [mx, my] = polar(r, r, r, (from + to) / 2);
    const d = `M${trim(x0, 2)},${trim(y0, 2)} A${trim(r, 2)},${trim(r, 2)} 0 ${String(big)} 1 ${trim(x1, 2)},${trim(y1, 2)} L${trim(x2, 2)},${trim(y2, 2)} A${trim(inner, 2)},${trim(inner, 2)} 0 ${String(big)} 0 ${trim(x3, 2)},${trim(y3, 2)} Z`;
    from = to;
    const rows: Tip['rows'] = [
      ['Value', formatValue(slice.value, unit)],
      ['Share', share(slice.value, total)],
    ];
    return { slice, d, tip: { title: slice.label, rows, x: mx, y: my } };
  });
}

/** DS-COMP-28 `donut`: shares of a whole around a centre value; each slice says its label, value and share. */
export function DonutChart(props: {
  readonly name: string;
  readonly slices: readonly Slice[];
  readonly centre: string;
  readonly centreLabel: string;
  readonly size?: number | undefined;
  readonly unit?: ChartUnit | undefined;
}): ReactElement {
  const size = props.size ?? 150;
  const r = size / 2;
  const points = usePoints(props.slices.length);
  const arcs = arcsOf(props.slices, r, r * 0.62, props.unit);
  const shown = points.shown === null ? undefined : arcs[points.shown];
  return (
    <figure className="chart chart--radial" role="group" aria-label={props.name}>
      <div className="chart__frame">
        <svg viewBox={`0 0 ${String(size)} ${String(size)}`} width={size} height={size}>
          {arcs.map((arc, i) => (
            <path
              key={arc.slice.label}
              className="chart__slice"
              data-tone={toneOf(arc.slice.tone, i)}
              d={arc.d}
              {...points.props(i, arc.tip)}
            />
          ))}
          <text className="chart__centre" x={r} y={r - 2} textAnchor="middle" aria-hidden="true">
            {props.centre}
          </text>
          <text
            className="chart__centre-label"
            x={r}
            y={r + 14}
            textAnchor="middle"
            aria-hidden="true"
          >
            {props.centreLabel}
          </text>
        </svg>
        {shown !== undefined && <Tooltip id={points.tipId} tip={shown.tip} />}
      </div>
    </figure>
  );
}

const GAUGE = { w: 150, h: 82, stroke: 9 } as const;
const gaugeR = (GAUGE.w - GAUGE.stroke) / 2 - 1;
const [gaugeX, gaugeY] = [GAUGE.w / 2, GAUGE.h - GAUGE.stroke / 2 - 1];

/** The gauge's arc from the left end to a fraction of the half turn; the large-arc flag is always 0. */
function gaugeArc(to: number): string {
  const [x0, y0] = polar(gaugeX, gaugeY, gaugeR, Math.PI);
  const [x1, y1] = polar(gaugeX, gaugeY, gaugeR, Math.PI + Math.PI * to);
  return `M${trim(x0, 2)},${trim(y0, 2)} A${trim(gaugeR, 2)},${trim(gaugeR, 2)} 0 0 1 ${trim(x1, 2)},${trim(y1, 2)}`;
}

/** The target tick across the gauge's stroke at a fraction of the half turn. */
function GaugeTarget(props: { readonly at: number }): ReactElement {
  const angle = Math.PI + Math.PI * props.at;
  const [tx1, ty1] = polar(gaugeX, gaugeY, gaugeR + GAUGE.stroke / 2, angle);
  const [tx2, ty2] = polar(gaugeX, gaugeY, gaugeR - GAUGE.stroke / 2, angle);
  return (
    <line
      className="chart__target"
      x1={trim(tx1, 2)}
      y1={trim(ty1, 2)}
      x2={trim(tx2, 2)}
      y2={trim(ty2, 2)}
    />
  );
}

/** DS-COMP-28 `gauge`: a half arc filled to the value, with a tick at the target. Values are percentages. */
export function Gauge(props: {
  readonly name: string;
  readonly value: number;
  readonly target?: number | undefined;
  readonly suffix?: string | undefined;
  readonly tone?: ChartTone | undefined;
}): ReactElement {
  const suffix = props.suffix ?? '%';
  const value = `${String(Math.round(props.value))}${suffix}`;
  const name = `${props.name}: ${value}${props.target === undefined ? '' : `, target ${String(Math.round(props.target))}${suffix}`}`;
  return (
    <figure className="chart chart--radial" role="img" aria-label={name}>
      <svg
        viewBox={`0 0 ${String(GAUGE.w)} ${String(GAUGE.h)}`}
        width={GAUGE.w}
        height={GAUGE.h}
        aria-hidden="true"
      >
        <path className="chart__track" d={gaugeArc(1)} />
        {fraction(props.value) > 0 && (
          <path
            className="chart__arc"
            data-tone={props.tone ?? 'accent'}
            d={gaugeArc(fraction(props.value))}
          />
        )}
        {props.target !== undefined && <GaugeTarget at={fraction(props.target)} />}
        <text className="chart__value" x={gaugeX} y={gaugeY - 12} textAnchor="middle">
          {value}
        </text>
      </svg>
    </figure>
  );
}

/** DS-COMP-28 `score dial`: a Lighthouse score as a ring, coloured by its band. */
export function ScoreDial(props: {
  readonly label: string;
  readonly score: number;
  readonly size?: number | undefined;
}): ReactElement {
  const size = props.size ?? 84;
  const stroke = 6;
  const r = (size - stroke) / 2 - 1;
  const c = size / 2;
  const round = 2 * Math.PI * r;
  const filled = fraction(props.score);
  const score = Math.round(props.score);
  return (
    <div className={`dial is-${scoreBand(props.score)}`}>
      <svg
        viewBox={`0 0 ${String(size)} ${String(size)}`}
        width={size}
        height={size}
        role="img"
        aria-label={`${props.label}: ${String(score)} out of 100`}
      >
        <circle className="chart__track" cx={c} cy={c} r={trim(r, 2)} />
        <circle
          className="chart__ring"
          cx={c}
          cy={c}
          r={trim(r, 2)}
          strokeDasharray={`${trim(round * filled, 2)} ${trim(round * (1 - filled), 2)}`}
          transform={`rotate(-90 ${String(c)} ${String(c)})`}
        />
        <text
          className="dial__score"
          x={c}
          y={c}
          textAnchor="middle"
          dominantBaseline="central"
          aria-hidden="true"
        >
          {score}
        </text>
      </svg>
      <div className="dial__label" aria-hidden="true">
        {props.label}
      </div>
    </div>
  );
}
