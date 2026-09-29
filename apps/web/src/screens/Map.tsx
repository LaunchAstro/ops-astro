// SPDX-License-Identifier: AGPL-3.0-only
//
// The map view (WF-3): a map's Destination, Notes, Decisions so far, Not yet
// specified (the fog) and Out of scope, each edited in place, with the version
// history `map revised` writes.
//
// **One read, one command.** Everything drawn comes from `map.view`, which
// answers the map's sections, its decisions, its versions and its record
// revision in one call. Every edit is `map.revise` with that revision, so a
// second writer who moved the map on gets `VERSION_STALE` rather than a lost
// update. After an applied edit the page reads the map again: the new version
// in the history is the server's, never one this file numbered.
//
// **The command's state lives above the read.** A reread unmounts the loaded
// view (`RecordState` draws its loading voice), so a refusal held inside it
// would vanish together with the attempt it was about. It is held here, and
// the screen registry keys this screen by map and grant, so another map or
// another reader starts with none (a closed edit included).
//
// The look waits on the accepted prototype W4 (#603); until then the page is
// drawn with the kit's existing section and button classes.

import type { ReactElement } from 'react';
import { COMMAND_SURFACE } from '../../../../packages/core-wire/src/index.ts';
import type { MapViewResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient, WireRefusal } from '../operations/client.ts';
import { useRead } from '../data/use-read.ts';
import { useCommand } from '../records/use-command.ts';
import { RecordState } from '../views/record-state.tsx';
import { MapSections, type Revise } from './map/Sections.tsx';

export interface MapScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** The map's key (or its identifier), as the address carries it. */
  readonly mapKey: string;
}

// Codes about who may act. A grant refusal does not name the key it looked
// for, so the page names the one `map.revise` is declared with, as the CLI's
// refusal line does (`apps/cli/render.ts`).
const AUTHORITY = /GRANT|PERMIT|DELEGATION|AUTH|AGENT/u;
const REVISE = COMMAND_SURFACE.find((row) => row.name === 'map.revise');
const REVISE_KEY = REVISE === undefined ? 'task:write' : `${REVISE.collection}:${REVISE.action}`;

function needs(refusal: WireRefusal | undefined): string | null {
  return refusal !== undefined && AUTHORITY.test(refusal.code)
    ? `You need ${REVISE_KEY} to change this map.`
    : null;
}

export function MapScreen(props: MapScreenProps): ReactElement {
  const client = props.client;
  const { state, reload } = useRead<MapViewResult>({
    grantKey: props.grantKey,
    run: () => client.read<MapViewResult>('map.view', { recordId: props.mapKey }),
    deps: [props.mapKey],
  });
  const command = useCommand();

  const revise: Revise = (map, body) => {
    command.run(
      () =>
        client.mutate(
          'map.revise',
          { recordId: map.id, ...body },
          { expectedRevision: map.revision },
        ),
      (settlement) => {
        // Applied, or stale: either way the map on screen is no longer the
        // server's, so read it again. A refusal leaves the map as it was.
        if (settlement.kind === 'ok' || settlement.kind === 'stale') reload();
      },
    );
  };

  return (
    <div className="stack" data-map-refused={state.outcome === 'denied' ? '' : undefined}>
      {command.failure === null ? null : (
        <p className="field__error" role="alert" data-map-failure="">
          {command.failure.because}{' '}
          {needs('refusal' in command.failure ? command.failure.refusal : undefined)}
        </p>
      )}
      <RecordState state={state} subject="map" onRetry={reload}>
        {(value) => <MapSections map={value.map} busy={command.locked} onRevise={revise} />}
      </RecordState>
    </div>
  );
}
