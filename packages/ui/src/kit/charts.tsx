// SPDX-License-Identifier: AGPL-3.0-only
//
// Chart primitives (MP-1-5): DS-COMP-27 axis charts (line, column), DS-COMP-28
// radial charts (donut, gauge, score dial), DS-COMP-29's sparkline and
// DS-COMP-40's true-scale funnel. Hand-drawn SVG, no chart library, so the
// page carries no chart runtime.
//
// Colour comes from a tone on the element through `currentColor`, so the SVG
// never names a colour and every chart follows the theme. Text inside the SVG
// is set by the type scale's classes, never by font attributes.
//
// Axis charts measure the width they are given and redraw when it changes. A
// chart that is hidden when it mounts (a closed tab) is zero wide and draws no
// series; when it is shown the observer reports its width and it draws. Line,
// column and donut charts show each point's value on hover and on keyboard
// focus (R57): the chart is one tab stop and the arrow keys walk its points. A
// second quantity is drawn against its own labelled right-hand axis (R58),
// never divided to fit the first.

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';

export type ChartTone = 'accent' | 'ink' | 'muted' | 'ok' | 'warn' | 'bad' | 'info';
/** What a value counts: money is shown in dollars, a count only in whole steps. */
export type ChartUnit = 'number' | 'count' | 'money';

export interface Series {
  readonly label: string;
  readonly values: readonly number[];
  readonly unit?: ChartUnit | undefined;
  readonly tone?: ChartTone | undefined;
  /** A second quantity goes on the right, against its own axis (R58). */
  readonly axis?: 'left' | 'right' | undefined;
  readonly dashed?: boolean | undefined;
  readonly area?: boolean | undefined;
}

export interface Slice {
  readonly label: string;
  readonly value: number;
  readonly tone?: ChartTone | undefined;
}

export interface FunnelStep {
  readonly label: string;
  readonly count: number;
  /** A stage drawn above the funnel for context (sessions above enquiries), never to scale. */
  readonly context?: boolean | undefined;
}

const TONES: readonly ChartTone[] = ['accent', 'ink', 'info', 'muted'];
const toneOf = (tone: ChartTone | undefined, index: number): ChartTone =>
  tone ?? TONES[index % TONES.length] ?? 'accent';

// -- Numbers ------------------------------------------------------------------

/** A number with no more than `places` decimals and no trailing zeros. */
const trim = (value: number, places: number): string => String(Number(value.toFixed(places)));

/**
 * Round gridline values from `lo` to at least `hi`: about `count` steps of 1, 2,
 * 2.5 or 5 times a power of ten, whole steps for a count. An empty range still
 * gets one step, so nothing divides by zero.
 */
export function axisTicks(
  lo: number,
  hi: number,
  options: { readonly integer?: boolean; readonly count?: number } = {},
): readonly number[] {
  const low = Math.min(lo, 0);
  const high = Math.max(hi, low);
  if (high === low) return [low, low + 1];
  const raw = (high - low) / (options.count ?? 4);
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  let step =
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) *
    power;
  if (options.integer === true) step = Math.max(1, Math.ceil(step));
  const start = Math.floor(low / step) * step;
  const end = Math.max(Math.ceil(high / step) * step, start + step);
  const ticks: number[] = [];
  for (let at = start; at <= end + step / 2; at += step) ticks.push(Number(at.toPrecision(12)));
  return ticks;
}

/**
 * A gridline's label: compact (k, M) on the scale of the largest tick, with as
 * many decimals as the step needs so no two labels read the same.
 */
export function formatTick(
  tick: number,
  ticks: readonly number[],
  unit: ChartUnit = 'number',
): string {
  const largest = Math.max(...ticks.map((t) => Math.abs(t)));
  const [scale, suffix] = largest >= 1e6 ? [1e6, 'M'] : largest >= 1e3 ? [1e3, 'k'] : [1, ''];
  const step = ticks.length > 1 ? Math.abs((ticks[1] ?? 0) - (ticks[0] ?? 0)) / scale : 1;
  const places = String(Number(step.toPrecision(12))).split('.')[1]?.length ?? 0;
  const text = tick === 0 ? '0' : `${trim(tick / scale, places)}${suffix}`;
  return unit === 'money' ? `${tick < 0 ? '-' : ''}$${text.replace('-', '')}` : text;
}

/** A value in full, the way a tooltip says it. */
export function formatValue(value: number, unit: ChartUnit = 'number'): string {
  const places = Number.isInteger(value) ? 0 : 2;
  const text = Math.abs(value).toLocaleString('en-AU', {
    minimumFractionDigits: unit === 'money' ? places : 0,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '-' : ''}${unit === 'money' ? '$' : ''}${text}`;
}

const share = (part: number, whole: number): string =>
  `${trim(whole === 0 ? 0 : (part / whole) * 100, 2)}%`;

/** Google's Lighthouse bands: 0 to 49 fail, 50 to 89 average, 90 to 100 good. */
export const scoreBand = (score: number): 'ok' | 'warn' | 'bad' =>
  score >= 90 ? 'ok' : score >= 50 ? 'warn' : 'bad';

// -- Measuring ----------------------------------------------------------------

/** The width of the element, kept current by the browser's resize observer. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    setWidth(Math.round(element.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const seen = entries.at(-1)?.contentRect.width;
      if (seen !== undefined) setWidth(Math.round(seen));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

// -- Points, focus and the tooltip --------------------------------------------

interface Tip {
  readonly title: string;
  readonly rows: readonly (readonly [string, string])[];
  readonly x: number;
  readonly y: number;
}

const tipLabel = (tip: Tip): string =>
  `${tip.title}: ${tip.rows.map(([label, value]) => `${label} ${value}`).join(', ')}`;

/**
 * One tab stop over a chart's points. The pointer shows a point's tip while it
 * is over it; focus shows it too, and the arrow keys, Home and End move focus
 * along the points. Hovering never moves the tab stop.
 */
function usePoints(count: number): {
  readonly shown: number | null;
  readonly props: (index: number, tip: Tip) => Record<string, unknown>;
  readonly tipId: string;
} {
  const tipId = useId();
  const [stop, setStop] = useState(0);
  const [shown, setShown] = useState<number | null>(null);
  const nodes = useRef<(SVGElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number): void => {
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? count - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(count - 1, next));
    setStop(target);
    nodes.current[target]?.focus();
  };
  const props = (index: number, tip: Tip): Record<string, unknown> => ({
    ref: (node: SVGElement | null) => {
      nodes.current[index] = node;
    },
    role: 'img',
    'aria-label': tipLabel(tip),
    'aria-describedby': shown === index ? tipId : undefined,
    tabIndex: index === Math.min(stop, count - 1) ? 0 : -1,
    onMouseEnter: () => {
      setShown(index);
    },
    onMouseLeave: () => {
      setShown(null);
    },
    onFocus: () => {
      setStop(index);
      setShown(index);
    },
    onBlur: () => {
      setShown(null);
    },
    onKeyDown: (event: KeyboardEvent) => {
      move(event, index);
    },
  });
  return { shown, props, tipId };
}

function Tooltip(props: { readonly id: string; readonly tip: Tip }): ReactElement {
  return (
    <div
      className="chart__tip"
      role="tooltip"
      id={props.id}
      style={{ left: `${trim(props.tip.x, 1)}px`, top: `${trim(props.tip.y, 1)}px` }}
    >
      <span className="chart__tip-title">{props.tip.title}</span>
      {props.tip.rows.map(([label, value]) => (
        <span key={label} className="chart__tip-row">
          <span>{label}</span> <span className="chart__tip-value">{value}</span>
        </span>
      ))}
    </div>
  );
}

// -- Axes ---------------------------------------------------------------------

// `titled` is the top when two axes carry their titles above the plot.
const PAD = { top: 14, titled: 30, bottom: 26, left: 44, right: 14, second: 48 } as const;

interface Axis {
  readonly ticks: readonly number[];
  readonly unit: ChartUnit;
  readonly label: string;
  /** The y of a value on this axis. */
  readonly y: (value: number) => number;
}

function axisFor(
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

/** Gridlines and labels for the left axis, the right axis if there is one, and the x labels. */
function Axes(props: {
  readonly left: Axis;
  readonly right: Axis | null;
  readonly plot: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly labels: readonly string[];
  readonly xOf: (index: number) => number;
  readonly bottom: number;
}): ReactElement {
  const { left, right, plot } = props;
  const every = Math.max(1, Math.ceil(props.labels.length / Math.max(2, Math.floor(plot.w / 56))));
  return (
    <g aria-hidden="true">
      {left.ticks.map((tick) => (
        <g key={tick}>
          <line
            className="chart__grid"
            x1={plot.x}
            x2={plot.x + plot.w}
            y1={left.y(tick)}
            y2={left.y(tick)}
          />
          <text
            className="chart__axis chart__axis--y"
            x={plot.x - 8}
            y={left.y(tick) + 3.5}
            textAnchor="end"
          >
            {formatTick(tick, left.ticks, left.unit)}
          </text>
        </g>
      ))}
      {right?.ticks.map((tick) => (
        <text
          key={tick}
          className="chart__axis chart__axis--right"
          x={plot.x + plot.w + 8}
          y={right.y(tick) + 3.5}
          textAnchor="start"
        >
          {formatTick(tick, right.ticks, right.unit)}
        </text>
      ))}
      {right !== null && (
        <>
          <text
            className="chart__axis-title chart__axis-title--left"
            x={0}
            y={10}
            textAnchor="start"
          >
            {left.label}
          </text>
          <text
            className="chart__axis-title chart__axis-title--right"
            x={plot.x + plot.w + PAD.second}
            y={10}
            textAnchor="end"
          >
            {right.label}
          </text>
        </>
      )}
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

const pathOf = (points: readonly (readonly [number, number])[]): string =>
  points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${trim(x, 1)},${trim(y, 1)}`).join(' ');

const rowsAt = (series: readonly Series[], index: number): readonly (readonly [string, string])[] =>
  series.map((s) => [s.label, formatValue(s.values[index] ?? 0, s.unit)] as const);

interface AxisChartProps {
  readonly name: string;
  readonly labels: readonly string[];
  readonly height?: number | undefined;
}

/** The frame both axis charts share: the measured holder, the named group and the tooltip. */
function Frame(props: {
  readonly name: string;
  readonly holder: RefObject<HTMLDivElement | null>;
  readonly height: number;
  readonly width: number;
  readonly tip: ReactElement | null;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <figure className="chart" role="group" aria-label={props.name}>
      <div
        className="chart__frame"
        ref={props.holder}
        style={{ height: `${String(props.height)}px` }}
      >
        {props.width > 0 && (
          <svg
            viewBox={`0 0 ${String(props.width)} ${String(props.height)}`}
            width={props.width}
            height={props.height}
          >
            {props.children}
          </svg>
        )}
        {props.tip}
      </div>
    </figure>
  );
}

/** DS-COMP-27 `line`: values over time, one line per series, an area under the first. */
export function LineChart(
  props: AxisChartProps & { readonly series: readonly Series[] },
): ReactElement {
  const height = props.height ?? 240;
  const [holder, width] = useWidth();
  const n = props.labels.length;
  const points = usePoints(n);
  const leftSeries = props.series.filter((s) => s.axis !== 'right');
  const rightSeries = props.series.filter((s) => s.axis === 'right');
  const two = rightSeries.length > 0;
  const top = two ? PAD.titled : PAD.top;
  const plot = {
    x: PAD.left,
    y: top,
    w: Math.max(0, width - PAD.left - (two ? PAD.second : PAD.right)),
    h: height - top - PAD.bottom,
  };
  const left = axisFor(leftSeries, plot.y, plot.h);
  const right = axisFor(rightSeries, plot.y, plot.h);
  const xOf = (i: number): number => plot.x + (n === 1 ? plot.w / 2 : (i / (n - 1)) * plot.w);
  const slot = n === 1 ? plot.w : plot.w / (n - 1);
  const tipAt = (i: number): Tip => ({
    title: props.labels[i] ?? '',
    rows: rowsAt(props.series, i),
    x: xOf(i),
    y: plot.y,
  });
  const shown = points.shown;
  return (
    <Frame
      name={props.name}
      holder={holder}
      height={height}
      width={width}
      tip={shown === null || width === 0 ? null : <Tooltip id={points.tipId} tip={tipAt(shown)} />}
    >
      {left === null ? (
        <g />
      ) : (
        <>
          <rect className="chart__plot" x={plot.x} y={plot.y} width={plot.w} height={plot.h} />
          <Axes
            left={left}
            right={right}
            plot={plot}
            labels={props.labels}
            xOf={xOf}
            bottom={height}
          />
          {shown !== null && (
            <line
              className="chart__cursor"
              x1={xOf(shown)}
              x2={xOf(shown)}
              y1={plot.y}
              y2={plot.y + plot.h}
            />
          )}
          {props.series.map((s, k) => {
            const axis = s.axis === 'right' && right !== null ? right : left;
            const pts = s.values.slice(0, n).map((v, i) => [xOf(i), axis.y(v)] as const);
            const line = pathOf(pts);
            return (
              <g key={s.label} data-tone={toneOf(s.tone, k)} aria-hidden="true">
                {(s.area ?? k === 0) && pts.length > 1 && (
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
          })}
          {props.labels.map((label, i) => (
            <rect
              key={label}
              className="chart__hit"
              x={Math.max(plot.x, xOf(i) - slot / 2)}
              y={plot.y}
              width={Math.min(slot, plot.w)}
              height={plot.h}
              {...points.props(i, tipAt(i))}
            />
          ))}
        </>
      )}
    </Frame>
  );
}

/** DS-COMP-27 `column`: grouped bars per label, with an optional dashed line series on top. */
export function ColumnChart(
  props: AxisChartProps & {
    readonly bars: readonly Series[];
    readonly line?: Series | undefined;
    readonly stacked?: boolean | undefined;
  },
): ReactElement {
  const height = props.height ?? 220;
  const [holder, width] = useWidth();
  const n = props.labels.length;
  const points = usePoints(n);
  const line = props.line;
  const onRight = line?.axis === 'right';
  const top = onRight ? PAD.titled : PAD.top;
  const plot = {
    x: PAD.left,
    y: top,
    w: Math.max(0, width - PAD.left - (onRight ? PAD.second : PAD.right)),
    h: height - top - PAD.bottom,
  };
  const left = axisFor(
    line !== undefined && !onRight ? [...props.bars, line] : props.bars,
    plot.y,
    plot.h,
    props.stacked === true,
  );
  const right = line !== undefined && onRight ? axisFor([line], plot.y, plot.h) : null;
  const slot = n === 0 ? 0 : plot.w / n;
  const bar = Math.min(26, slot * 0.62);
  const xOf = (i: number): number => plot.x + slot * i + slot / 2;
  const all = line === undefined ? props.bars : [...props.bars, line];
  const tipAt = (i: number): Tip => ({
    title: props.labels[i] ?? '',
    rows: rowsAt(all, i),
    x: xOf(i),
    y: plot.y,
  });
  const shown = points.shown;
  const base = left?.y(0) ?? plot.y + plot.h;
  return (
    <Frame
      name={props.name}
      holder={holder}
      height={height}
      width={width}
      tip={shown === null || width === 0 ? null : <Tooltip id={points.tipId} tip={tipAt(shown)} />}
    >
      {left === null ? (
        <g />
      ) : (
        <>
          <rect className="chart__plot" x={plot.x} y={plot.y} width={plot.w} height={plot.h} />
          <Axes
            left={left}
            right={right}
            plot={plot}
            labels={props.labels}
            xOf={xOf}
            bottom={height}
          />
          {props.labels.map((label, i) => {
            let below = 0;
            return (
              <g key={label} aria-hidden="true" className={shown === i ? 'is-active' : undefined}>
                {props.bars.map((s, k) => {
                  const v = s.values[i] ?? 0;
                  const group = bar / props.bars.length;
                  const [x, w] =
                    props.stacked === true
                      ? [xOf(i) - bar / 2, bar]
                      : [xOf(i) - bar / 2 + group * k, Math.max(1, group - 1.5)];
                  const [from, to] = props.stacked === true ? [below, below + v] : [0, v];
                  below += props.stacked === true ? v : 0;
                  const y = Math.min(left.y(from), left.y(to));
                  return (
                    <rect
                      key={s.label}
                      className="chart__bar"
                      data-tone={toneOf(s.tone, k)}
                      x={x}
                      y={y}
                      width={w}
                      height={Math.abs(left.y(to) - left.y(from)) || (from === to ? 0 : 1)}
                    />
                  );
                })}
              </g>
            );
          })}
          {line !== undefined && (
            <g data-tone={toneOf(line.tone, props.bars.length)} aria-hidden="true">
              <path
                className="chart__line"
                d={pathOf(
                  line.values.slice(0, n).map((v, i) => [xOf(i), (right ?? left).y(v)] as const),
                )}
                strokeDasharray="4 3"
              />
              {line.values.slice(0, n).map((v, i) => (
                <circle
                  key={props.labels[i] ?? i}
                  className="chart__dot"
                  cx={xOf(i)}
                  cy={(right ?? left).y(v)}
                  r={2.4}
                />
              ))}
            </g>
          )}
          {props.labels.map((label, i) => (
            <rect
              key={label}
              className="chart__hit"
              x={plot.x + slot * i}
              y={plot.y}
              width={slot}
              height={Math.max(0, base - plot.y)}
              {...points.props(i, tipAt(i))}
            />
          ))}
        </>
      )}
    </Frame>
  );
}

// -- Radial -------------------------------------------------------------------

const polar = (
  cx: number,
  cy: number,
  radius: number,
  angle: number,
): readonly [number, number] => [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];

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
  const inner = r * 0.62;
  const total = props.slices.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const points = usePoints(props.slices.length);
  let from = -Math.PI / 2;
  const arcs = props.slices.map((slice) => {
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
    return {
      slice,
      d,
      tip: {
        title: slice.label,
        rows: [
          ['Value', formatValue(slice.value, props.unit)],
          ['Share', share(slice.value, total)],
        ],
        x: mx,
        y: my,
      } as Tip,
    };
  });
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

/** A percentage as a fraction, held between 0 and 1. */
const fraction = (percent: number): number => Math.max(0, Math.min(1, percent / 100));

/** DS-COMP-28 `gauge`: a half arc filled to the value, with a tick at the target. Values are percentages. */
export function Gauge(props: {
  readonly name: string;
  readonly value: number;
  readonly target?: number | undefined;
  readonly suffix?: string | undefined;
  readonly tone?: ChartTone | undefined;
}): ReactElement {
  const [w, h, stroke] = [150, 82, 9];
  const r = (w - stroke) / 2 - 1;
  const [cx, cy] = [w / 2, h - stroke / 2 - 1];
  // A half turn at most, so the large-arc flag is always 0.
  const arc = (to: number): string => {
    const [x0, y0] = polar(cx, cy, r, Math.PI);
    const [x1, y1] = polar(cx, cy, r, Math.PI + Math.PI * to);
    return `M${trim(x0, 2)},${trim(y0, 2)} A${trim(r, 2)},${trim(r, 2)} 0 0 1 ${trim(x1, 2)},${trim(y1, 2)}`;
  };
  const suffix = props.suffix ?? '%';
  const value = `${String(Math.round(props.value))}${suffix}`;
  const target = props.target === undefined ? null : fraction(props.target);
  const [tx1, ty1] =
    target === null ? [0, 0] : polar(cx, cy, r + stroke / 2, Math.PI + Math.PI * target);
  const [tx2, ty2] =
    target === null ? [0, 0] : polar(cx, cy, r - stroke / 2, Math.PI + Math.PI * target);
  const name = `${props.name}: ${value}${props.target === undefined ? '' : `, target ${String(Math.round(props.target))}${suffix}`}`;
  return (
    <figure className="chart chart--radial" role="img" aria-label={name}>
      <svg viewBox={`0 0 ${String(w)} ${String(h)}`} width={w} height={h} aria-hidden="true">
        <path className="chart__track" d={arc(1)} />
        {fraction(props.value) > 0 && (
          <path
            className="chart__arc"
            data-tone={props.tone ?? 'accent'}
            d={arc(fraction(props.value))}
          />
        )}
        {target !== null && (
          <line
            className="chart__target"
            x1={trim(tx1, 2)}
            y1={trim(ty1, 2)}
            x2={trim(tx2, 2)}
            y2={trim(ty2, 2)}
          />
        )}
        <text className="chart__value" x={cx} y={cy - 12} textAnchor="middle">
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

// -- Inline -------------------------------------------------------------------

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
      data-tone={props.tone ?? 'ink'}
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
      {props.steps.map((step) => {
        const at = real.indexOf(step);
        const next = real[at + 1];
        const previous = at > 0 ? real[at - 1] : undefined;
        // Stepped accent tints, 12% at the top to 56% at the bottom; a context row 6%.
        const depth =
          step.context === true
            ? 0.06
            : 0.12 + (real.length > 1 ? (0.44 * at) / (real.length - 1) : 0);
        const style = {
          '--w': `${trim(step.context === true ? 100 : width(step.count), 2)}%`,
          '--next': `${trim(step.context === true || next === undefined ? width(step.count) : width(next.count), 2)}%`,
          '--depth': trim(depth, 3),
        } as CSSProperties;
        return (
          <div
            key={step.label}
            className={`funnel__step${step.context === true ? ' funnel__step--ctx' : ''}`}
          >
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
      })}
      {last !== undefined && real.length > 1 && (
        <p className="funnel__foot">
          {share(last.count, first)} end to end, {real[0]?.label.toLowerCase()} to{' '}
          {last.label.toLowerCase()}
        </p>
      )}
    </div>
  );
}
