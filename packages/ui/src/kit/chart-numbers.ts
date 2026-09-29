// SPDX-License-Identifier: AGPL-3.0-only
//
// The chart primitives' numbers and shared shapes (MP-1-5): the types a chart
// takes, the gridline ticks and their labels, values the way a tooltip says
// them, and the small geometry the charts share. No markup.

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
export const toneOf = (tone: ChartTone | undefined, index: number): ChartTone =>
  tone ?? TONES[index % TONES.length] ?? 'accent';

/** A number with no more than `places` decimals and no trailing zeros, never in exponent form. */
export function trim(value: number, places: number): string {
  const fixed = value.toFixed(Math.min(places, 100));
  const text = fixed.includes('.') ? fixed.replace(/\.?0+$/u, '') : fixed;
  return text === '-0' ? '0' : text;
}

/** How many decimals a value needs, read from its exponent so 2.5e-8 needs nine. */
function decimalsOf(value: number): number {
  const [mantissa = '', exponent = '0'] = Number(value.toPrecision(12)).toExponential().split('e');
  return Math.max(0, (mantissa.split('.')[1]?.length ?? 0) - Number(exponent));
}

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
  const places = decimalsOf(step);
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

export const share = (part: number, whole: number): string =>
  `${trim(whole === 0 ? 0 : (part / whole) * 100, 2)}%`;

/** Google's Lighthouse bands: 0 to 49 fail, 50 to 89 average, 90 to 100 good. */
export const scoreBand = (score: number): 'ok' | 'warn' | 'bad' =>
  score >= 90 ? 'ok' : score >= 50 ? 'warn' : 'bad';

/** A percentage as a fraction, held between 0 and 1. */
export const fraction = (percent: number): number => Math.max(0, Math.min(1, percent / 100));

/** The point at `angle` on a circle about (cx, cy). */
export const polar = (
  cx: number,
  cy: number,
  radius: number,
  angle: number,
): readonly [number, number] => [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];

/** An SVG path through the points, in order. */
export const pathOf = (points: readonly (readonly [number, number])[]): string =>
  points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${trim(x, 1)},${trim(y, 1)}`).join(' ');

/** Each series' label and its value at one index, as a tooltip lists them. */
export const rowsAt = (
  series: readonly Series[],
  index: number,
): readonly (readonly [string, string])[] =>
  series.map((s) => [s.label, formatValue(s.values[index] ?? 0, s.unit)] as const);
