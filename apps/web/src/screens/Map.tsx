// SPDX-License-Identifier: AGPL-3.0-only
//
// A Wayfinder map: the map view (WF-3), a map's Destination, Notes, Decisions
// so far, Not yet specified (the fog) and Out of scope, each edited in place,
// with the version history `map revised` writes; and the tickets, frontier and
// fog views (WF-4), moved between as tabs that keep the map and its filters.
//
// **One read, and each write through its owning command.** Everything drawn
// comes from `map.view` (the frontier view adds `map.frontier`, its read
// model), which answers the map's sections, decisions, versions, tickets and
// the revisions a write sends back. Every write carries its target's revision,
// so a second writer who moved it on gets `VERSION_STALE`, not a lost update.
// After an applied edit the page reads the map again: the new version in the
// history is the server's, never one this file numbered.
//
// **The command's state and the drafts live above the read.** A reread
// unmounts the loaded view unless kept, so a refusal or typed words held
// inside it would vanish with the attempt they were about. They are held
// here, as TaskDetail holds its draft: a save refused VERSION_STALE keeps
// the words, rereads the map and draws the conflict, and a second save sends
// them against the latest revision. The screen registry keys this screen by
// map and grant, so another map or another reader starts with none.
//
// The look waits on the accepted prototype W4 (#603); until then the page is
// drawn with the kit's existing section and button classes.

import { useState, type ReactElement } from 'react';
import type { MapViewResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { useRead } from '../data/use-read.ts';
import type { ReadState } from '../data/authorised-read.ts';
import { useCommand } from '../records/use-command.ts';
import { keyOf, needsKey } from '../records/needs-key.ts';
import { RecordState } from '../views/record-state.tsx';
import { MapViews } from './map/Views.tsx';
import {
  NO_FILTERS,
  type Filters,
  type Drafts,
  type Locked,
  type MapCommand,
  type MapViewName,
  type Send,
} from './map/model.ts';

export interface MapScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** The map's key (or its identifier), as the address carries it. */
  readonly mapKey: string;
}

/** Whether two graduate forms hold the same patch and lines. */
const sameForm = (one: Drafts['graduating'], two: Drafts['graduating']) =>
  JSON.stringify(one) === JSON.stringify(two);

/** What a `SCOPE_NOT_GRANTED` closes: the command's key on that one record. */
const latch = (name: MapCommand, recordId: string) => `${keyOf(name) ?? name} ${recordId}`;

/**
 * The typed words, held above the read, and the slot whose save came back
 * stale. `sending(slot)` notes what a save sends and answers the step that,
 * once it applies, drops the slot only if it still holds that: words typed
 * while the save was on its way stay in the editor. Words dropped unsaved
 * (Cancel, Dismiss, an emptied line) take their conflict with them: nothing
 * is kept, so nothing is offered to save again.
 */
function useDrafts() {
  const [texts, setTexts] = useState<Readonly<Record<string, string>>>({});
  const [graduating, setGraduating] = useState<Drafts['graduating']>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const unconflict = (slot: string) => {
    setConflict((now) => (now === slot ? null : now));
  };
  const setText = (slot: string, text: string | null) => {
    if (text === null) unconflict(slot);
    setTexts(({ [slot]: _dropped, ...rest }) => (text === null ? rest : { ...rest, [slot]: text }));
  };
  const setForm = (form: Drafts['graduating']) => {
    if (form === null) unconflict('graduate');
    setGraduating(form);
  };
  const sending = (slot: string): (() => void) => {
    if (slot === 'graduate') {
      const sentForm = graduating;
      return () => {
        setGraduating((now) => (sameForm(now, sentForm) ? null : now));
      };
    }
    const sentText = texts[slot];
    return () => {
      setTexts((now) => {
        if (now[slot] !== sentText) return now;
        const { [slot]: _saved, ...rest } = now;
        return rest;
      });
    };
  };
  const text = (slot: string) => texts[slot] ?? null;
  const drafts: Drafts = { text, setText, graduating, setGraduating: setForm, conflict };
  const open = graduating !== null || Object.keys(texts).length > 0;
  return { drafts, open, sending, setConflict };
}

/**
 * The page's writes: one at a time, each followed by a reread unless refused.
 * A `SCOPE_NOT_GRANTED` closes the refused key on the refused record only, so
 * a ticket the reader may not write leaves the ones they may write open.
 */
function useWrites(client: OperationsClient, reload: () => void) {
  const command = useCommand();
  const [sent, setSent] = useState<MapCommand>('map.revise');
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const { drafts, open, sending, setConflict } = useDrafts();
  const send: Send = (name, recordId, revision, body, slot) => {
    const applied = slot === undefined ? undefined : sending(slot);
    setSent(name);
    setConflict(null);
    command.run(
      () => client.mutate(name, { recordId, ...body }, { expectedRevision: revision }),
      (settlement) => {
        if (settlement.kind === 'ok') applied?.();
        if (settlement.kind === 'closed') {
          setShut((now) => new Set(now).add(latch(name, recordId)));
        }
        if (settlement.kind === 'stale' && slot !== undefined) setConflict(slot);
        // Applied, or stale: either way the map on screen is no longer the
        // server's, so read it again. A refusal leaves the map as it was.
        if (settlement.kind === 'ok' || settlement.kind === 'stale') reload();
      },
    );
  };
  const locked: Locked = (name, recordId) => command.busy || shut.has(latch(name, recordId));
  return { command, sent, send, locked, drafts, open };
}

/**
 * The graduate form's patch is not on the map as last read: it was graduated
 * or removed. The form is then kept to copy or dismiss, and no
 * second save is offered (`Frontier.tsx`).
 */
function patchGone(state: ReadState<MapViewResult>, drafts: Drafts): boolean {
  const form = drafts.graduating;
  const shown = state.outcome === 'loading' ? state.previous : state.value;
  if (drafts.conflict !== 'graduate' || form === null || shown === null) return false;
  return !shown.map.fog.some((patch) => patch.id === form.patch);
}

export function MapScreen(props: MapScreenProps): ReactElement {
  const client = props.client;
  const { state, reload } = useRead<MapViewResult>({
    grantKey: props.grantKey,
    run: () => client.read<MapViewResult>('map.view', { recordId: props.mapKey }),
    deps: [props.mapKey],
  });
  const { command, sent, send, locked, drafts, open } = useWrites(client, reload);
  // Held above the read, so a reread after a write keeps the view and filters.
  const [view, setView] = useState<MapViewName>('map');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  return (
    <div className="stack" data-map-refused={state.outcome === 'denied' ? '' : undefined}>
      {command.failure === null ? null : (
        <p className="field__error" role="alert" data-map-failure="">
          {command.failure.because}{' '}
          {needsKey(sent, 'refusal' in command.failure ? command.failure.refusal : undefined)}
        </p>
      )}
      {drafts.conflict === null || patchGone(state, drafts) ? null : (
        <p className="field__error" data-map-conflict="">
          Someone else changed this map while you were typing. What you typed is kept; save it again
          to write it over the latest version.
        </p>
      )}
      <RecordState state={state} subject="map" onRetry={reload} keep={open}>
        {(value) => (
          <MapViews
            map={value.map}
            client={client}
            grantKey={props.grantKey}
            view={view}
            onView={setView}
            filters={filters}
            onFilters={setFilters}
            locked={locked}
            send={send}
            drafts={drafts}
          />
        )}
      </RecordState>
    </div>
  );
}
