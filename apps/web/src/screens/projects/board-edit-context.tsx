// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { tabOwnerGeneration, type StorageLike } from '../../session/token.ts';
import { useRereadOn } from '../task/reread-on.ts';
import { BoardEditCustody } from './board-edit-custody.ts';
const Edits = createContext<BoardEditCustody | null>(null);
export function BoardEditProvider(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly storage: StorageLike | null;
  readonly children: ReactNode;
}) {
  const generation = tabOwnerGeneration();
  const custody = useMemo(
    () => new BoardEditCustody(props.client, props.grantKey, props.storage),
    [props.grantKey, props.storage, generation],
  );
  useLayoutEffect(() => custody.rebind(props.client), [custody, props.client]);
  useEffect(() => {
    custody.activate();
    return custody.dispose;
  }, [custody]);
  const state = useSyncExternalStore(custody.subscribe, custody.snapshot, custody.serverSnapshot);
  return (
    <Edits value={custody}>
      {state.problem === null ? null : (
        <p role="alert" data-board-edit-problem>
          {state.problem}
        </p>
      )}
      {props.children}
    </Edits>
  );
}
export function useBoardEdits(client: OperationsClient, grantKey = client.businessKey) {
  const shared = use(Edits);
  const custody = useMemo(
    () => shared ?? new BoardEditCustody(client, grantKey, null, true),
    [shared, client, grantKey],
  );
  useEffect(() => {
    if (shared !== null) return;
    custody.activate();
    return custody.dispose;
  }, [custody, shared]);
  const state = useSyncExternalStore(custody.subscribe, custody.snapshot, custody.serverSnapshot);
  return { custody, state };
}
export function BoardEditRecoveries(props: {
  readonly custody: BoardEditCustody;
  readonly tasks: readonly { readonly id: string; readonly title: string | null }[];
}) {
  const state = useSyncExternalStore(
    props.custody.subscribe,
    props.custody.snapshot,
    props.custody.serverSnapshot,
  );
  return (
    <>
      {props.tasks.map((task) => {
        const hold = state.holds.get(task.id);
        return hold === undefined ? null : (
          <div key={task.id} role="status" data-board-edit-held={task.id} data-board-edit-recovery>
            <p>
              {task.title ?? 'Task'}:{' '}
              {hold.notice ??
                (hold.entry.knowledge === 'answered'
                  ? 'The answer is known; only cleanup remains.'
                  : 'The change may already have been applied. Retry keeps the original change.')}
            </p>
            <button
              className="btn"
              type="button"
              disabled={hold.busy}
              data-board-edit-retry={task.id}
              onClick={() => {
                void props.custody.retry(task.id);
              }}
            >
              Retry
            </button>
          </div>
        );
      })}
    </>
  );
}

export function useBoardEditRead(client: OperationsClient, grantKey: string, refresh: () => void) {
  const edits = useBoardEdits(client, grantKey);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(
    () =>
      edits.custody.settled((_entry, answer) =>
        setSaid(answer.kind === 'ok' ? null : answer.because),
      ),
    [edits.custody],
  );
  useRereadOn(edits.state.changed, refresh);
  return { ...edits, said };
}
