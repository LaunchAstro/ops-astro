// SPDX-License-Identifier: AGPL-3.0-only
//
// The subtask list on the Team side (MP-4-4).

import type { ReactElement } from 'react';
import type { StepView } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';

export function SubtaskList(_props: {
  readonly client: OperationsClient;
  readonly parentId: string;
  readonly steps: readonly StepView[];
  readonly showFinished: boolean;
  readonly onShowFinished: (value: boolean) => void;
  readonly onChanged: () => void;
}): ReactElement {
  return <section className="sb__sect" data-steps />;
}
