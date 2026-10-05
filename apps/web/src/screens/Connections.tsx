// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal (MP-14-7a): registered at `/connections/`, drawing
// nothing yet. The fleet's sections follow in the next change.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../operations/client.ts';

export function ConnectionsScreen(_props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly now?: () => number;
}): ReactElement {
  return <div className="secs" data-screen="connections" />;
}
