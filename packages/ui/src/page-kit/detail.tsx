// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub: the row that opens to its detail, before its tests pass.

import type { ReactElement, ReactNode } from 'react';

export interface DetailRowProps {
  readonly title: string;
  readonly trail?: ReactNode;
  readonly detail: ReactNode;
  readonly items?: readonly string[] | undefined;
  readonly open?: boolean | undefined;
}

export function DetailRow(_props: DetailRowProps): ReactElement | null {
  return null;
}
