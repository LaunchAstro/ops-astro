// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { tabOwnerGeneration, type StorageLike } from '../../session/token.ts';
import { AssignmentCustody, EMPTY_ASSIGNMENT } from './assignment-custody.ts';

const Assignments = createContext<AssignmentCustody | null>(null);

export function AssignmentProvider(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly storage: StorageLike | null;
  readonly children: ReactNode;
}) {
  const generation = tabOwnerGeneration();
  const custody = useMemo(
    () => new AssignmentCustody(props.client, props.grantKey, props.storage),
    [props.grantKey, props.storage, generation],
  );
  useLayoutEffect(() => {
    custody.rebind(props.client);
  }, [custody, props.client]);
  useEffect(() => {
    custody.activate();
    return custody.dispose;
  }, [custody]);
  return <Assignments value={custody}>{props.children}</Assignments>;
}

/** Isolated mounts use explicitly ephemeral custody; App supplies its durable owner. */
export function useAssignments(client: OperationsClient, grantKey = client.businessKey) {
  const shared = use(Assignments);
  const custody = useMemo(
    () => shared ?? new AssignmentCustody(client, grantKey, null, true),
    [shared, client, grantKey],
  );
  useEffect(() => {
    if (shared !== null) return;
    custody.activate();
    return custody.dispose;
  }, [custody, shared]);
  const state = useSyncExternalStore(custody.subscribe, custody.snapshot, custody.snapshot);
  return { custody, state, shared: shared !== null };
}

export function useTaskAssignment(
  client: OperationsClient,
  grantKey: string | undefined,
  id: string,
  onChanged: () => void,
) {
  const assignment = useAssignments(client, grantKey);
  const hold = assignment.state.holds.get(id) ?? EMPTY_ASSIGNMENT;
  const observed = useRef(assignment.state.changed);
  useEffect(() => {
    if (observed.current === assignment.state.changed) return;
    observed.current = assignment.state.changed;
    if (!assignment.shared && hold.pending === null && hold.failure === null) onChanged();
  }, [assignment, hold, onChanged]);
  const locked = hold.pending !== null || !hold.kept || hold.failure?.kind === 'closed';
  return { ...assignment, hold, locked };
}
