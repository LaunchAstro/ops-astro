// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-2 stub, replaced by the change that follows the red tests.

import type { ReactElement } from 'react';

export const GLYPH_NAMES: readonly string[] = [];
export type GlyphName = string;

export interface IconProps {
  readonly name: GlyphName;
  readonly label?: string;
  readonly size?: 'xs' | 'sm' | 'md' | 'lg';
}

export function Icon(_props: IconProps): ReactElement | null {
  return null;
}
