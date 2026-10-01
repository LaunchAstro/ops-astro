// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement, ReactNode } from 'react';
import type { FrameFactsSource } from './frame-seam.ts';

export function DockSeat(props: {
  readonly source: FrameFactsSource;
  readonly children: ReactNode;
}): ReactElement {
  return <>{props.children}</>;
}
