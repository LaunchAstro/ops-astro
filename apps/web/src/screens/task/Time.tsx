// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-6: a stub, red before the time section.

import type { ReactElement } from 'react';
import type { TaskTimeView } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';

export function minutesText(_minutes: number): string {
  return '';
}

export function burnOf(
  _totalMinutes: number,
  _estimateMinutes: number | null,
): { readonly percent: number; readonly danger: boolean } | null {
  return null;
}

export function TimeLog(_props: {
  readonly client: OperationsClient;
  readonly taskId: string;
  readonly time: TaskTimeView;
  readonly estimateMinutes: number | null;
  readonly showAll: boolean;
  readonly onShowAll: (value: boolean) => void;
  readonly onChanged: () => void;
}): ReactElement {
  return <div data-time-log-section />;
}
