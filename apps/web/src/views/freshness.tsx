// SPDX-License-Identifier: AGPL-3.0-only
//
// C4's header marker (CS-1.1, SH-22): not built yet.

import type { ReactElement, ReactNode } from 'react';

export function PageFreshnessProvider(props: { readonly children: ReactNode }): ReactElement {
  return <>{props.children}</>;
}

export function StripFreshness(): ReactElement | null {
  return null;
}
