// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page with no task on it (MP-4-1, TKM-01 to TKM-04, CS-4.38): an id
// nothing is filed under, and an address that named none. The two are worded
// apart, the id is quoted exactly as it was typed (never in capitals, D-14),
// and both offer the board. Neither draws any other task: there is no
// fallback.
//
// An unknown id is the server's `NOT_FOUND`, and the server gives that one
// answer for a task that does not exist and one in another business, on
// purpose. So this page says the same for both, quotes the refusal as it came,
// and stays the denied outcome it is: denied is never drawn as empty.

import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { WireRefusal } from '../../operations/client.ts';
import { describeRefusal } from '../../records/submit.ts';
import { pathTo } from '../../routes.ts';

function BoardDoor(): ReactElement {
  return (
    <a className="btn" href={pathTo('agency:projects-board')}>
      Open the projects board →
    </a>
  );
}

/** `task.read` refused `NOT_FOUND` for the key in the address. */
export function TaskUnknown(props: {
  readonly typed: string;
  readonly refusal: WireRefusal;
}): ReactElement {
  return (
    <div className="readstate" data-outcome="denied" data-absent="unknown" role="alert">
      <Empty
        title={`No task is filed under “${props.typed}”.`}
        description={describeRefusal(props.refusal)}
        hint="Check the address, or find the task on the board."
        action={<BoardDoor />}
      />
    </div>
  );
}

/** `/task/` with no key: nothing was asked for, so nothing is read. */
export function TaskUnnamed(): ReactElement {
  return (
    <div className="readstate" data-absent="unnamed">
      <Empty
        title="No task was named."
        description="This address has no task on the end of it."
        hint="Open a task from the board."
        action={<BoardDoor />}
      />
    </div>
  );
}
