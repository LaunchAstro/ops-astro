// SPDX-License-Identifier: AGPL-3.0-only
//
// The brand marks (MP-1-2; SIDEBAR.md DS-SIDE-12): the wordmark for the
// expanded rail and the planet for the collapsed rail and small marks.
//
// Each is a CSS mask over `currentColor` rather than an image, so one black
// SVG serves both themes and the mark takes whatever ink its host sets. It is
// decoration: the product's name is always written beside it in words.

import type { ReactElement } from 'react';

export interface BrandMarkProps {
  readonly variant: 'wordmark' | 'planet';
}

export function BrandMark(props: BrandMarkProps): ReactElement {
  return <span className={`brand brand--${props.variant}`} aria-hidden="true" />;
}
