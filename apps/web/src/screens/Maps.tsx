// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { MapListResult } from '../../../../packages/core-wire/src/index.ts';
import { useRead } from '../data/use-read.ts';
import type { RollupFloor } from '../data/rollup-floor.ts';
import type { OperationsClient } from '../operations/client.ts';
import { pathTo } from '../routes.ts';
import { RecordState } from '../views/record-state.tsx';
import { titleOf } from '../views/task-title.ts';

export function MapsScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly rollup: RollupFloor;
}): ReactElement {
  const { client, grantKey } = props;
  const { state, reload } = useRead<MapListResult>({
    grantKey,
    run: () => client.read<MapListResult>('map.list', {}),
    deps: [client],
    rollup: props.rollup,
    isEmpty: (listed) => listed.maps.length === 0,
  });
  return (
    <section className="stack" aria-label="Maps">
      <RecordState
        state={state}
        subject="map list"
        onRetry={reload}
        empty={
          <Empty
            title="No maps yet."
            description="Chart a map with the wayfinder skill to plan a set of tickets."
          />
        }
      >
        {(listed) => (
          <ul className="stack">
            {listed.maps.map((map) => (
              <li key={map.id} className="card">
                <a className="sb__addr" href={pathTo('agency:map', { key: map.key ?? map.id })}>
                  {titleOf(map.title)}
                </a>
              </li>
            ))}
          </ul>
        )}
      </RecordState>
    </section>
  );
}
