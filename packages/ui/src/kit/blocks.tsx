// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3 stub, replaced by the change that follows the red tests.

import type { ReactElement, ReactNode } from 'react';
import type { MarkTone } from './marks.tsx';

export interface Column {
  readonly key: string;
  readonly label: string;
  readonly align?: 'start' | 'end' | 'centre' | undefined;
  /** Sortable heads are buttons, so a keyboard can reach them. */
  readonly sort?: 'ascending' | 'descending' | 'none' | undefined;
  readonly onSort?: (() => void) | undefined;
}

export interface TableProps {
  readonly caption: string;
  readonly columns: readonly Column[];
  readonly rows: readonly Readonly<Record<string, ReactNode>>[];
  readonly dense?: boolean | undefined;
  /** The one export control a table carries in its head slot (C15), when it offers one. */
  readonly exportControl?: ReactNode;
}

export interface CardProps {
  readonly title?: string | undefined;
  readonly sub?: string | undefined;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** Rows run to the edge (a list card). */
  readonly flush?: boolean | undefined;
  /** The current choice in a set of cards: accent border and a 3px inset rule (DR-9). */
  readonly current?: boolean | undefined;
}

export interface DoorCardProps {
  readonly href: string;
  readonly title: string;
  readonly sub?: string | undefined;
  readonly look?: 'card' | 'row' | 'cta' | undefined;
  readonly external?: boolean | undefined;
}

export interface ListRowProps {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly lead?: ReactNode;
  readonly trail?: ReactNode;
  readonly look?: 'page' | 'panel' | 'notice' | 'record' | undefined;
  readonly state?: 'selected' | 'done' | 'archived' | 'gate' | undefined;
}

export interface BannerProps {
  readonly tone?: 'warn' | 'bad' | 'info' | undefined;
  readonly lead?: string | undefined;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly onDismiss?: (() => void) | undefined;
}

export interface MeterProps {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly tone?: MarkTone | undefined;
  readonly look?: 'meter' | 'stat' | 'time' | undefined;
  /** A target tick, in the same units. */
  readonly target?: number | undefined;
  readonly over?: boolean | undefined;
}

export interface KpiProps {
  readonly label: string;
  readonly explain?: string | undefined;
  readonly value: string;
  readonly of?: string | undefined;
  readonly track?: { readonly value: number; readonly max: number } | undefined;
  readonly delta?: string | undefined;
}

export function Table(_props: TableProps): ReactElement | null {
  return null;
}

export function Card(_props: CardProps): ReactElement | null {
  return null;
}

export function DoorCard(_props: DoorCardProps): ReactElement | null {
  return null;
}

export function ListRow(_props: ListRowProps): ReactElement | null {
  return null;
}

export function FormLayout(_props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly onSubmit?: (() => void) | undefined;
}): ReactElement | null {
  return null;
}

export function Banner(_props: BannerProps): ReactElement | null {
  return null;
}

export function Meter(_props: MeterProps): ReactElement | null {
  return null;
}

export function Kpi(_props: KpiProps): ReactElement | null {
  return null;
}

export function Skeleton(_props: {
  readonly shape: 'field' | 'line' | 'tile';
}): ReactElement | null {
  return null;
}

export function RowNote(_props: { readonly children: ReactNode }): ReactElement | null {
  return null;
}

export function MockRegion(_props: {
  readonly children: ReactNode;
  readonly nested?: boolean | undefined;
  readonly word?: boolean | undefined;
}): ReactElement | null {
  return null;
}

export function Popover(_props: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement | null {
  return null;
}

export function locate(_target: HTMLElement): void {
  // stub
}
