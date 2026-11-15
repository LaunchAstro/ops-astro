// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's one field write (`PanelFields.tsx`): `task.update` or
// `task.set_stage` at a revision, under an operation id held per intent.

import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { submitEdit } from '../../records/submit.ts';
import { useCommand, type Settlement } from '../../records/use-command.ts';
import { holding, useHeldOperations } from './held-operations.ts';

interface FieldWriteProps {
  readonly client: OperationsClient;
  readonly task: Task;
  readonly onChanged: () => void;
}

type FieldCommand = 'task.update' | 'task.set_stage';

/**
 * One field write at the read revision, or the one an edit started from; a
 * landed one is counted. The same write sent again after a lost answer goes
 * under the same operation id, so the server replays what it stored.
 */
export function useFieldWrite(props: FieldWriteProps) {
  const { busy, because, run } = useCommand();
  const held = useHeldOperations();
  const write = (
    command: FieldCommand,
    fields: Readonly<Record<string, unknown>>,
    revision = props.task.revision,
    then?: (settlement: Settlement) => void,
  ): void => {
    const recordId = props.task.id;
    const hold = holding(held, command, { recordId, revision, fields }, () =>
      props.client.newOperationId(),
    );
    run(
      () =>
        submitEdit(props.client, {
          command,
          recordId,
          expectedRevision: revision,
          fields,
          operationId: hold.id,
        }),
      (settlement) => {
        hold.settle(settlement.kind);
        if (settlement.kind === 'ok') props.onChanged();
        then?.(settlement);
      },
    );
  };
  return { busy, because, write };
}
