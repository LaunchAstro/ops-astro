// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel's own line (MP-7-10): the reader is in, or away with the
// reason they gave. Nothing sets it but the person, so nothing here watches
// time or input.

import { useState, type ReactElement } from 'react';
import type { Availability, AvailabilityChange } from '../state/team.ts';

/** Setting Away: the reason is required, in the person's own words. */
function AwayForm(props: {
  readonly onSet: (change: AvailabilityChange) => void;
  readonly onClose: () => void;
}): ReactElement {
  const [reason, setReason] = useState('');
  const said = reason.trim();
  return (
    <form
      className="tmc__me"
      onSubmit={(event) => {
        event.preventDefault();
        if (said === '') return;
        props.onSet({ away: true, reason: said });
        props.onClose();
      }}
    >
      <label className="tmc__why">
        Why you are away
        <input
          name="reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </label>
      <button type="submit" className="btn btn--primary btn--sm" disabled={said === ''}>
        Away
      </button>
      <button type="button" className="btn btn--sm tmc__cancel" onClick={props.onClose}>
        Cancel
      </button>
    </form>
  );
}

/** The reader's own line: in, away with their reason, or just away when they gave none. */
function sentence(away: Availability | null): string {
  if (away === null) return 'You are in';
  return away.reason === null ? 'You are away' : `You are away: ${away.reason}`;
}

/** The reader's own availability: in, or away with their reason. */
export function Mine(props: {
  readonly away: Availability | null;
  readonly onSet: (change: AvailabilityChange) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <AwayForm
        onSet={props.onSet}
        onClose={() => {
          setEditing(false);
        }}
      />
    );
  }
  const away = props.away;
  return (
    <p className="tmc__me">
      <span>{sentence(away)}</span>
      <button
        type="button"
        className={`btn btn--sm ${away === null ? 'tmc__set' : 'tmc__back'}`}
        onClick={() => {
          if (away === null) setEditing(true);
          else props.onSet({ away: false });
        }}
      >
        {away === null ? 'Set yourself away' : 'Back in'}
      </button>
    </p>
  );
}
