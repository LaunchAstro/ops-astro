// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: a person's delete and its request's data effects (#2345, #2351), spread into
// `COMMAND_EFFECTS`. A request is its own row on its task; Confirm answers it and deletes as
// `task.delete` does.

import type { DeleteRequestCommandName } from './surface-bin-names.ts';
import { client, writing, type DataEffects } from './data-effects-types.ts';
import { TASK } from './data-effects-shapes.ts';

export const DELETE_REQUEST_EFFECTS: {
  readonly [Name in 'task.delete' | DeleteRequestCommandName]: DataEffects;
} = {
  'task.delete': TASK,
  'task.request_delete': writing(client('task_delete_requests')),
  'task.confirm_delete': writing([...TASK.writes, ...client('task_delete_requests')]),
  'task.decline_delete': writing(client('task_delete_requests')),
};
