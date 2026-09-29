// SPDX-License-Identifier: AGPL-3.0-only
//
// Chart primitives (MP-1-5). Typed stubs for the red run.

import type { ReactElement } from 'react';

export type ChartTone = 'accent' | 'ink' | 'muted' | 'ok' | 'warn' | 'bad' | 'info';
export type ChartUnit = 'number' | 'count' | 'money';
export interface Series {
  readonly label: string;
  readonly values: readonly number[];
  readonly unit?: ChartUnit | undefined;
  readonly tone?: ChartTone | undefined;
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
  readonly context?: boolean | undefined;
}

export const axisTicks = (
  _lo: number,
  _hi: number,
  _options?: { readonly integer?: boolean },
): readonly number[] => [];
export const formatTick = (_tick: number, _ticks: readonly number[], _unit?: ChartUnit): string =>
  '';
export const scoreBand = (_score: number): 'ok' | 'warn' | 'bad' => 'bad';

export function LineChart(_props: {
  readonly name: string;
  readonly labels: readonly string[];
  readonly series: readonly Series[];
  readonly height?: number;
}): ReactElement {
  return <figure className="chart" />;
}
export function ColumnChart(_props: {
  readonly name: string;
  readonly labels: readonly string[];
  readonly bars: readonly Series[];
  readonly line?: Series | undefined;
  readonly height?: number;
}): ReactElement {
  return <figure className="chart" />;
}
export function DonutChart(_props: {
  readonly name: string;
  readonly slices: readonly Slice[];
  readonly centre: string;
  readonly centreLabel: string;
  readonly size?: number;
}): ReactElement {
  return <figure className="chart" />;
}
export function Gauge(_props: {
  readonly name: string;
  readonly value: number;
  readonly target?: number | undefined;
}): ReactElement {
  return <figure className="chart" />;
}
export function ScoreDial(_props: {
  readonly label: string;
  readonly score: number;
}): ReactElement {
  return <figure className="chart" />;
}
export function Sparkline(_props: {
  readonly name: string;
  readonly values: readonly number[];
}): ReactElement {
  return <figure className="chart" />;
}
export function Funnel(_props: {
  readonly name: string;
  readonly steps: readonly FunnelStep[];
}): ReactElement {
  return <figure className="chart" />;
}
