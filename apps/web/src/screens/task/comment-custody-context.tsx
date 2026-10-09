// SPDX-License-Identifier: AGPL-3.0-only
import {
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { tabOwnerGeneration, type StorageLike } from '../../session/token.ts';
import { CommentCustody } from './comment-custody.ts';
import { HeldComments } from './held-operations.ts';

export function CommentCustodyProvider(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly storage: StorageLike | null;
  readonly children: ReactNode;
}) {
  const generation = tabOwnerGeneration();
  const custody = useMemo(
    () => new CommentCustody(props.client, props.grantKey, props.storage),
    [props.grantKey, props.storage, generation],
  );
  useLayoutEffect(() => {
    custody.rebind(props.client);
  }, [custody, props.client]);
  useEffect(() => {
    custody.activate();
    return custody.dispose;
  }, [custody]);
  return <HeldComments value={custody}>{props.children}</HeldComments>;
}

/** Isolated Comments mounts use the same controller, with explicitly ephemeral custody. */
export function useCommentCustody(
  client: OperationsClient,
  grantKey: string | undefined,
  id: string,
) {
  const shared = use(HeldComments);
  const own = useMemo(
    () => shared ?? new CommentCustody(client, grantKey ?? client.businessKey, null, true),
    [shared, client, grantKey],
  );
  useEffect(() => {
    if (shared !== null) return;
    own.activate();
    return own.dispose;
  }, [own, shared]);
  const hold = useSyncExternalStore(
    own.subscribe,
    () => own.snapshot(id),
    () => own.snapshot(id),
  );
  return { custody: own, hold };
}
