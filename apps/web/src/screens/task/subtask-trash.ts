// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';
import type { OperationsClient } from '../../operations/client.ts';

export interface SubtaskTrashReceipt {
  readonly batchId: string;
  readonly count: number;
}
interface TrashStore {
  receipts: readonly SubtaskTrashReceipt[];
  readonly listeners: Set<() => void>;
}
// A successful removal outlives the parent's reread. Custody stays in memory,
// under this signed-in client and parent; another owner never inherits it.
const owners = new WeakMap<OperationsClient, Map<string, TrashStore>>();

export function useSubtaskTrash(client: OperationsClient, parentId: string) {
  let parents = owners.get(client);
  if (parents === undefined) {
    parents = new Map();
    owners.set(client, parents);
  }
  let found = parents.get(parentId);
  if (found === undefined) {
    found = { receipts: [], listeners: new Set() };
    parents.set(parentId, found);
  }
  const store = found;
  const receipts = useSyncExternalStore(
    (notify) => {
      store.listeners.add(notify);
      return () => {
        store.listeners.delete(notify);
      };
    },
    () => store.receipts,
  );
  const put = (next: readonly SubtaskTrashReceipt[]): void => {
    store.receipts = next;
    for (const notify of store.listeners) notify();
  };
  return {
    receipts,
    keep: (receipt: SubtaskTrashReceipt) => {
      if (!store.receipts.some((item) => item.batchId === receipt.batchId))
        put([...store.receipts, receipt]);
    },
    restored: (batchId: string) => put(store.receipts.filter((item) => item.batchId !== batchId)),
  };
}
