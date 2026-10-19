// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement, ReactNode } from 'react';
export function LiveFrame(props: {
  readonly pageUrl: string;
  readonly loadKey: string;
  readonly capture: ReactNode | null;
}): ReactElement {
  return <div data-live-view="">{props.capture}</div>;
}
