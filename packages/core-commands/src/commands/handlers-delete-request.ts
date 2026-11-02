// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's delete (#2345) and the request's three (#2351), spread into `handlers.ts`'s
// table, which is at its line cap.

import type { DeleteRequestCommandName } from '../../../core-wire/src/surface-bin-names.ts';
import type { Handler } from './handler-types.ts';
import { deleteTask } from './tasks-delete.ts';
import { answerDeleteRequest, requestDelete } from './tasks-delete-request.ts';

export const DELETE_REQUEST_HANDLERS: {
  readonly [K in 'task.delete' | DeleteRequestCommandName]: Handler<K>;
} = {
  'task.delete': (tx, context) => deleteTask(tx, context),
  'task.request_delete': (tx, context, request) => requestDelete(tx, context, request.reason),
  'task.confirm_delete': (tx, context, request) =>
    answerDeleteRequest(tx, context, 'confirmed', request.requestId),
  'task.decline_delete': (tx, context, request) =>
    answerDeleteRequest(tx, context, 'kept', request.requestId),
};
