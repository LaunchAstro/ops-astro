// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import type { OperationsClient } from '../operations/client.ts';

export function ExecutiveScreen(_props: {
  readonly client: OperationsClient;
  readonly now?: () => number;
}): ReactElement {
  return <main />;
}
