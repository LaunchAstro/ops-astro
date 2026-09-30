// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's page link (MP-4-12): skeleton, drawn inert.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';

export interface PageLinkProps {
  readonly client: OperationsClient;
  readonly task: Task;
  readonly onChanged: () => void;
}

export function PageLink(_props: PageLinkProps): ReactElement {
  return (
    <div className="dtp__link">
      <button className="btn" type="button" data-page-link="set">
        Link here
      </button>
    </div>
  );
}
