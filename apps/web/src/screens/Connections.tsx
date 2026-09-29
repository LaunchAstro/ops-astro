// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal (MP-14-7a): not built yet.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../operations/client.ts';

export function ConnectionsScreen(_props: {
  readonly client: OperationsClient;
  readonly now?: () => number;
}): ReactElement {
  return <section data-screen="connections" />;
}
