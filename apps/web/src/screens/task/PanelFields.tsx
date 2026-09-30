// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's field grid (MP-4-8): skeleton, drawn inert.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';

export interface PanelFieldsProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly task: Task;
  readonly onChanged: () => void;
}

export function PanelFields(_props: PanelFieldsProps): ReactElement {
  return (
    <div className="dtp__fields">
      <select id="panel-field-assignee" className="input" aria-label="Assignee" />
      <button className="btn" type="button" data-panel-field="due">
        Not set
      </button>
    </div>
  );
}
