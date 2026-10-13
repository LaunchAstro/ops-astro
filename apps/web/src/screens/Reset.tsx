// SPDX-License-Identifier: AGPL-3.0-only
//
// `/reset` (stub).

import type { ReactElement } from 'react';

export interface ResetScreenProps {
  readonly path: string;
  readonly gotrueUrl: string;
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  readonly tab: Pick<Window, 'location' | 'history'>;
}

export function ResetScreen(_props: ResetScreenProps): ReactElement {
  return <div data-screen="reset" />;
}
