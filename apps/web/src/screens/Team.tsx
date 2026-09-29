// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel (MP-7-10): the people strip, each teammate's availability as
// a word (never a colour alone), and the person's own availability with a
// reason (CS-7.27). The strip is `team.list`, staff only, and a client is
// answered NOT_FOUND by the server, so this screen never decides who is
// staff. The conversations (C71-D direct, C71-G group) take the section left
// for them below the strip.

import { useState, type FormEvent, type ReactElement } from 'react';
import type { TeamListResult, TeamMemberView } from '../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../operations/client.ts';
import { useRead } from '../data/use-read.ts';
import { RecordState } from '../views/record-state.tsx';
import { describeRefusal } from '../records/submit.ts';

export function TeamScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
}): ReactElement {
  const { client } = props;
  const { state, reload } = useRead<TeamListResult>({
    grantKey: props.grantKey,
    run: () => client.read<TeamListResult>('team.list', {}),
    isEmpty: (value) => value.people.length === 0,
    deps: [],
  });
  return (
    <div className="stack">
      <RecordState state={state} subject="team" onRetry={reload}>
        {(value) => (
          <>
            <PeopleStrip people={value.people} />
            <AvailabilityForm
              client={client}
              mine={value.people.find((person) => person.personId === value.you) ?? null}
              onSaved={reload}
            />
          </>
        )}
      </RecordState>
      <section className="sb__sect" data-team="conversations" aria-label="Conversations" />
    </div>
  );
}

function PeopleStrip(props: { readonly people: readonly TeamMemberView[] }): ReactElement {
  return (
    <section className="sb__sect">
      <div className="sb__sh">
        <span className="sb__k">People</span>
      </div>
      <ul className="sbact" data-team="people">
        {props.people.map((person) => (
          <li className="sbact__row" key={person.personId} data-person-id={person.personId}>
            <span>{person.name}</span>
            {person.availability?.state === 'away' ? (
              <span className="sbact__meta">
                <span className="sb__state" data-availability="away">
                  Away
                </span>
                {person.availability.reason === null ? null : (
                  <span> · {person.availability.reason}</span>
                )}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The person's own availability; mounted afresh by each read, so it starts from the saved one. */
function AvailabilityForm(props: {
  readonly client: OperationsClient;
  readonly mine: TeamMemberView | null;
  readonly onSaved: () => void;
}): ReactElement {
  const [away, setAway] = useState(props.mine?.availability?.state === 'away');
  const [reason, setReason] = useState(props.mine?.availability?.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [because, setBecause] = useState<string | null>(null);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const body = away
      ? { state: 'away', ...(reason.trim() === '' ? {} : { reason }) }
      : { state: 'available' };
    setBusy(true);
    void (async () => {
      const result = await props.client.setAvailability(body);
      setBusy(false);
      if (isRefusal(result)) setBecause(describeRefusal(result));
      else if (isUnavailable(result)) setBecause(result.because);
      else props.onSaved();
    })();
  };

  return (
    <form className="sb__sect" data-availability="form" onSubmit={onSubmit}>
      <div className="sb__sh">
        <span className="sb__k">Your availability</span>
      </div>
      <AvailabilityFields
        away={away}
        reason={reason}
        busy={busy}
        onAway={setAway}
        onReason={setReason}
      />
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
      <button className="btn btn--primary" type="submit" data-availability="save" disabled={busy}>
        Save
      </button>
    </form>
  );
}

function AvailabilityFields(props: {
  readonly away: boolean;
  readonly reason: string;
  readonly busy: boolean;
  readonly onAway: (away: boolean) => void;
  readonly onReason: (reason: string) => void;
}): ReactElement {
  const { away, reason, busy } = props;
  return (
    <>
      <div className="field">
        <label className="tf__k" htmlFor="availability-state">
          I am
        </label>
        <select
          id="availability-state"
          className="input"
          disabled={busy}
          value={away ? 'away' : 'available'}
          onChange={(event) => {
            props.onAway(event.target.value === 'away');
          }}
        >
          <option value="available">Available</option>
          <option value="away">Away</option>
        </select>
      </div>
      {away ? (
        <div className="field">
          <label className="tf__k" htmlFor="availability-reason">
            Reason (optional)
          </label>
          <input
            id="availability-reason"
            className="input"
            maxLength={140}
            disabled={busy}
            value={reason}
            onChange={(event) => {
              props.onReason(event.target.value);
            }}
          />
        </div>
      ) : null}
    </>
  );
}
