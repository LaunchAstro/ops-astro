// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { tabOwnerGeneration, type StorageLike } from '../../session/token.ts';
import { ScoresCustody } from './scores-custody.ts';

export const HeldScores = createContext<ScoresCustody | null>(null);
export function ScoresCustodyProvider(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly storage: StorageLike | null;
  readonly children: ReactNode;
}) {
  const generation = tabOwnerGeneration();
  const custody = useMemo(
    () => new ScoresCustody(props.client, props.grantKey, props.storage),
    [props.grantKey, props.storage, generation],
  );
  useLayoutEffect(() => {
    custody.rebind(props.client);
  }, [custody, props.client]);
  useEffect(() => {
    custody.activate();
    return custody.dispose;
  }, [custody]);
  return <HeldScores value={custody}>{props.children}</HeldScores>;
}
