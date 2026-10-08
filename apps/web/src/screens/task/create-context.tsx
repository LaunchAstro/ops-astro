// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { tabOwnerGeneration, type StorageLike } from '../../session/token.ts';
import { CreateCustody } from './create-custody.ts';
const Creates = createContext<CreateCustody | null>(null);
export function CreateProvider(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly storage: StorageLike | null;
  readonly children: ReactNode;
}) {
  const generation = tabOwnerGeneration();
  const custody = useMemo(
    () => new CreateCustody(props.client, props.grantKey, props.storage),
    [props.grantKey, props.storage, generation],
  );
  useLayoutEffect(() => {
    custody.rebind(props.client);
  }, [custody, props.client]);
  useEffect(() => {
    custody.activate();
    return custody.dispose;
  }, [custody]);
  return <Creates value={custody}>{props.children}</Creates>;
}
/** App supplies durable custody; isolated surface mounts explicitly keep memory only. */
export function useCreates(client: OperationsClient) {
  const shared = use(Creates);
  const custody = useMemo(
    () => shared ?? new CreateCustody(client, client.businessKey, null, true),
    [shared, client],
  );
  useEffect(() => {
    if (shared !== null) return;
    custody.activate();
    return custody.dispose;
  }, [custody, shared]);
  const state = useSyncExternalStore(custody.subscribe, custody.snapshot, custody.serverSnapshot);
  return { custody, state };
}
