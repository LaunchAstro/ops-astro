// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';

/** The authorised board's empty state; loading and refused reads never draw it. */
export function NoTasks(): ReactElement {
  return (
    <Empty
      title="No tasks on this board yet."
      description="You are permitted to see it and it has nothing in it."
      hint="Create one with the form above."
    />
  );
}
