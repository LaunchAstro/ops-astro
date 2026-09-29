// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3 stub, replaced by the change that follows the red tests.

import type { ReactElement, ReactNode } from 'react';
import type { GlyphName } from '../primitives/Icon.tsx';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'idle';

export type ChipProps =
  | {
      readonly kind?: 'outline' | 'soft' | undefined;
      readonly tone?: Tone | undefined;
      readonly icon?: GlyphName | undefined;
      readonly children: ReactNode;
    }
  | {
      /** A filter in force: key, value and its remove button. */
      readonly kind: 'filter';
      readonly name: string;
      readonly value: string;
      readonly onRemove: () => void;
    }
  | {
      /** A suggestion the reader can take. */
      readonly kind: 'suggestion';
      readonly children: ReactNode;
      readonly onClick: () => void;
    };

export interface CountProps {
  readonly n: number;
  readonly look?: 'badge' | 'corner' | 'plain' | 'numeral' | 'inline' | undefined;
  /** What is being counted, for a screen reader. */
  readonly label: string;
}

export interface StatusLineProps {
  readonly tone: Tone;
  readonly node?: boolean | undefined;
}

export interface StatusMarkProps {
  readonly tone: Tone;
  readonly children: string;
  readonly look?: 'chip' | 'text' | 'line' | undefined;
}

export interface AvatarProps {
  readonly name: string;
  readonly kind?: 'person' | 'person-large' | 'client' | undefined;
  /** The large person card's presence: on is an accent ring, away is dashed. */
  readonly presence?: 'on' | 'away' | undefined;
  /** In a stack, the person looking at this now. */
  readonly here?: boolean | undefined;
}

export interface TermProps {
  readonly children: ReactNode;
  readonly tip: string;
  readonly place?: 'below' | 'end' | 'down' | undefined;
}

export interface MarkerProps {
  readonly look: 'section' | 'key' | 'stamp' | 'kind';
  readonly children: ReactNode;
}

export type LinkProps =
  | {
      readonly look?: 'channel' | 'prose' | undefined;
      readonly href: string;
      readonly children: ReactNode;
      readonly door?: 'page' | 'external' | undefined;
    }
  | { readonly look: 'door'; readonly href: string; readonly label: string };

export function Chip(_props: ChipProps): ReactElement | null {
  return null;
}

export function Count(_props: CountProps): ReactElement | null {
  return null;
}

export function StatusLine(_props: StatusLineProps): ReactElement | null {
  return null;
}

export function StatusMark(_props: StatusMarkProps): ReactElement | null {
  return null;
}

export function Avatar(_props: AvatarProps): ReactElement | null {
  return null;
}

export function AvatarStack(_props: {
  readonly people: readonly AvatarProps[];
}): ReactElement | null {
  return null;
}

export function DoorMark(_props: {
  readonly to: keyof typeof DOORS_STUB | GlyphName;
}): ReactElement | null {
  return null;
}

export function Term(_props: TermProps): ReactElement | null {
  return null;
}

export function Marker(_props: MarkerProps): ReactElement | null {
  return null;
}

export function Index(_props: {
  readonly name: string;
  readonly value: ReactNode;
}): ReactElement | null {
  return null;
}

export function Countdown(_props: { readonly minutesLeft: number }): ReactElement | null {
  return null;
}

export function Link(_props: LinkProps): ReactElement | null {
  return null;
}

export function Divider(_props: {
  readonly look?: 'rule' | 'section' | 'vertical' | undefined;
}): ReactElement | null {
  return null;
}

export const DOORS_STUB = {
  page: 'arrow-small-right',
  external: 'arrow-up-right-from-square',
  agent: 'sparkles',
} as const;
