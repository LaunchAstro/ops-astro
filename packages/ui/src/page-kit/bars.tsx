// SPDX-License-Identifier: AGPL-3.0-only
//
// Stubs: the page kit's bar list, page meter and legend, before their tests pass.

import type { ReactElement } from 'react';

export interface Bar {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly display?: string | undefined;
}

export function barShares(_bars: readonly Bar[], _of?: number): readonly number[] {
  return [];
}

export function BarList(_props: {
  readonly label: string;
  readonly bars: readonly Bar[];
  readonly of?: number | undefined;
}): ReactElement | null {
  return null;
}

export interface PageMeterProps {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly target?: number | undefined;
  readonly tone?: 'ok' | 'warn' | 'bad' | undefined;
  readonly display?: string | undefined;
}

export function PageMeter(_props: PageMeterProps): ReactElement | null {
  return null;
}

export interface LegendItem {
  readonly id: string;
  readonly label: string;
  readonly tone: 'ink' | 'accent' | 'muted' | 'success' | 'warning' | 'danger';
}

export function Legend(_props: {
  readonly label: string;
  readonly items: readonly LegendItem[];
}): ReactElement | null {
  return null;
}
