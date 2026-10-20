// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';

export function OpenReview(_props: {
  readonly client: OperationsClient;
  readonly taskId: string;
  readonly onOpened: (reviewId: string) => void;
}): ReactElement | null {
  return null;
}
