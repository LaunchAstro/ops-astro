// SPDX-License-Identifier: AGPL-3.0-only
//
// What `/settings` says about the two reads and about a write that lost a race.
//
// Each of these draws one fact and none of them draws a value in a state
// nobody answered in. That is checklist B7 in its narrowest form: a screen that
// opened on the shipped default — `500`, `false` — would be telling a person
// their business's threshold having never asked anybody, and they would have no
// way to tell that number from a real one.
//
// The refusals are the server's own words. `describeRefusal` composes the code,
// the names and the fixes the server sent, and there is no table here turning a
// code into nicer language: a client-side copy of the refusal vocabulary is a
// second vocabulary, and the first time the server grows a code this one would
// be confidently wrong about it.

import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { ReadState } from '../../data/authorised-read.ts';
import { describeRefusal } from '../../records/submit.ts';
import { holdsManage, inWords, type CapabilitiesResult, type SettingRow } from './reads.ts';
import type { Conflict, Draft, Which } from './use-settings.ts';

export const draftInWords = (draft: Draft): string =>
  draft === null ? 'off' : typeof draft === 'boolean' ? (draft ? 'on' : 'off') : String(draft);

/** What the settings read is, in its own words. */
export function ReadBanner(props: { readonly state: ReadState<unknown> }): ReactElement {
  const state = props.state;
  return (
    <div className="readstate" data-settings="read" data-outcome={state.outcome}>
      {state.outcome === 'loading' ? (
        <p className="card__sub" role="status">
          Reading what this business holds…
        </p>
      ) : null}
      {state.outcome === 'denied' && state.refusal !== null ? (
        <Empty
          title="These values were not read."
          description={describeRefusal(state.refusal)}
          hint="The server refused the read. Nothing below is the business's value."
        />
      ) : null}
      {state.outcome === 'unavailable' ? (
        <Empty
          title="These values could not be read."
          description={state.because ?? 'The read did not arrive.'}
          hint="Nobody refused anything — the answer did not come back. Nothing below is the business's value."
        />
      ) : null}
      {state.outcome === 'empty' ? (
        <Empty
          title="This business holds neither setting yet."
          description="The read answered with no rows. Until one of them is written there is nothing to show, and a default drawn here would be a number nobody asked for."
          hint="Writing either setting below creates its row."
        />
      ) : null}
    </div>
  );
}

/** Why the controls are closed, when the capability read is the reason. */
export function CapabilityBanner(props: {
  readonly state: ReadState<CapabilitiesResult>;
}): ReactElement {
  const state = props.state;
  const answered = state.outcome === 'ready' || state.outcome === 'empty';
  const short = answered && !holdsManage(state.value?.grants ?? []);
  return (
    <div className="readstate" data-settings="capabilities" data-outcome={state.outcome}>
      {state.outcome === 'denied' && state.refusal !== null ? (
        <p className="field__error" role="alert" data-settings="capabilities-because">
          {describeRefusal(state.refusal)} The controls are closed: this screen could not find out
          what you may do and does not assume in your favour.
        </p>
      ) : null}
      {short ? (
        <p className="field__error" role="alert" data-settings="capabilities-because">
          Your session does not hold <code>settings:manage</code>, which both of these commands
          take. The controls are closed rather than sending a write nobody was going to accept.
        </p>
      ) : null}
    </div>
  );
}

/** The server's value for one setting, and when the server last wrote it. */
export function ValueLine(props: {
  readonly which: Which;
  readonly row: SettingRow | null;
}): ReactElement | null {
  const row = props.row;
  if (row === null) return null;
  return (
    <>
      <p className="card__sub" data-settings={`${props.which}-value`}>
        The business holds: <strong>{inWords(row)}</strong>
      </p>
      {row.updatedAt === undefined ? null : (
        <p className="card__sub" data-settings={`${props.which}-updated`}>
          Last written {row.updatedAt}
          {/*
            The live read answers `updatedByActorId: null` for a row the seed
            wrote, and null is a real answer: nobody, or nobody recorded.
            Printing it would be this screen inventing an actor called "null",
            which is the same defect as drawing a default one field along.
          */}
          {row.updatedByActorId === undefined || row.updatedByActorId === null
            ? ''
            : ` by ${row.updatedByActorId}`}
          {row.revision === undefined ? '' : `, revision ${String(row.revision)}`}
        </p>
      )}
    </>
  );
}

/**
 * Somebody else wrote while this person was typing.
 *
 * Both numbers are on the page — what the reread found and what the person
 * asked for — and the button is the person choosing between them. The screen
 * does not choose.
 */
export function ConflictBlock(props: {
  readonly conflict: Conflict;
  readonly row: SettingRow | null;
  readonly disabled: boolean;
  readonly onWriteOver: () => void;
}): ReactElement {
  const asked = draftInWords(props.conflict.draft);
  return (
    <div className="readstate" role="alert" data-settings="conflict">
      <p className="field__error">{props.conflict.because}</p>
      <p className="card__sub" data-settings="conflict-server">
        The server holds: <strong>{props.row === null ? 'not known' : inWords(props.row)}</strong>
      </p>
      <p className="card__sub" data-settings="conflict-draft">
        You asked for: <strong>{asked}</strong>
      </p>
      <button
        className="btn btn--primary"
        type="button"
        data-settings={`confirm-${props.conflict.which}`}
        disabled={props.disabled}
        onClick={props.onWriteOver}
      >
        Write {asked} over it
      </button>
    </div>
  );
}
