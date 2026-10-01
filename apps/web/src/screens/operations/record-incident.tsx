// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations view's one write (C55, CS-14.31): recording a privacy
// incident, the tracked action `privacy incident recorded`, which is
// `privacy.record_incident` under `privacy:manage` (the same command the API
// and the command line reach). The five day-0 facts are sent as typed and the
// server checks each (`privacy-write.ts`); this form guards none of them, so
// every refusal stays reachable. When it works the view is read again and the
// incident shows in its table. A refused field is drawn under that field in
// the server's words, with the code on the outcome line; a refused grant says
// the person may not record incidents. Either way nothing else is sent and
// what was typed stays.

import { useState, type FormEvent, type ReactElement } from 'react';
import { Button, Card, Checkbox, TextField } from '@launchastro/ui';
import { isRefusal, type OperationsClient, type WireRefusal } from '../../operations/client.ts';
import { describeFailure, describeRefusal } from '../../records/submit.ts';

/**
 * The kinds of information an incident can involve, in the record's order:
 * `INFORMATION_KINDS` in `core-records`, which the browser cannot load. The
 * screen case holds the two lists equal.
 */
const KINDS = [
  'contact',
  'identity',
  'financial',
  'health',
  'credentials',
  'client-files',
  'other',
] as const;

interface Facts {
  readonly whatHappened: string;
  readonly foundAt: string;
  readonly foundBy: string;
  readonly affected: string;
}

type Field = keyof Facts | 'informationKinds';

const BLANK: Facts = { whatHappened: '', foundAt: '', foundBy: '', affected: '' };

/** What a person reads when the send did not work, refusal or absence. */
function outcomeOf(result: Parameters<typeof describeFailure>[0]): string | null {
  if (isRefusal(result) && result.code === 'SCOPE_NOT_GRANTED') {
    return `You may not record privacy incidents here. ${describeRefusal(result)}`;
  }
  return describeFailure(result);
}

/** The server's fixes, under the field its refusal names. */
const errorOf = (refusal: WireRefusal | null, field: Field): string | undefined =>
  refusal?.names.includes(field) === true ? refusal.fixes.join(' ') || 'Refused.' : undefined;

function Kinds(props: {
  readonly chosen: ReadonlySet<string>;
  readonly onToggle: (kind: string) => void;
  readonly error: string | undefined;
}): ReactElement {
  return (
    <div
      className="field"
      data-field="informationKinds"
      role="group"
      aria-label="Information involved"
    >
      <span className="field__label">Information involved</span>
      <div className="btnrow">
        {KINDS.map((kind) => (
          <span className="btnrow" key={kind} data-kind={kind}>
            <Checkbox
              label={kind}
              checked={props.chosen.has(kind)}
              onChange={() => {
                props.onToggle(kind);
              }}
            />
            {kind}
          </span>
        ))}
      </div>
      {props.error === undefined ? null : <p className="field__error">{props.error}</p>}
    </div>
  );
}

function useRecord(client: OperationsClient, onRecorded: () => void) {
  const [facts, setFacts] = useState<Facts>(BLANK);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<WireRefusal | null>(null);
  const set = (field: keyof Facts) => (value: string) => {
    setFacts((was) => ({ ...was, [field]: value }));
  };
  const toggle = (kind: string): void => {
    setChosen(
      (was) => new Set(was.has(kind) ? [...was].filter((k) => k !== kind) : [...was, kind]),
    );
  };
  const send = async (): Promise<void> => {
    setBusy(true);
    const informationKinds = KINDS.filter((kind) => chosen.has(kind));
    const result = await client.mutate('privacy.record_incident', { ...facts, informationKinds });
    setBusy(false);
    setRefusal(isRefusal(result) ? result : null);
    setOutcome(outcomeOf(result));
    if ('ok' in result) onRecorded();
  };
  return { facts, set, chosen, toggle, busy, outcome, refusal, send };
}

export function RecordIncident(props: {
  readonly client: OperationsClient;
  readonly onRecorded: () => void;
}): ReactElement {
  const form = useRecord(props.client, props.onRecorded);
  const text = (
    field: keyof Facts,
    label: string,
    extra: { multiline?: boolean; hint?: string },
  ) => (
    <div data-field={field}>
      <TextField
        label={label}
        value={form.facts[field]}
        onChange={form.set(field)}
        error={errorOf(form.refusal, field)}
        {...extra}
      />
    </div>
  );
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void form.send();
  };
  return (
    <div data-section="record-incident">
      <Card title="Record a privacy incident" sub="Day 0 of the breach runbook: what is known now">
        <form className="stack" onSubmit={submit}>
          {text('whatHappened', 'What happened', { multiline: true })}
          {text('foundAt', 'Found at', { hint: 'An ISO 8601 time, e.g. 2026-10-01T09:00:00Z' })}
          {text('foundBy', 'Found by', {})}
          {text('affected', 'Clients and people affected', { multiline: true })}
          <Kinds
            chosen={form.chosen}
            onToggle={form.toggle}
            error={errorOf(form.refusal, 'informationKinds')}
          />
          {form.outcome === null ? null : (
            <p className="card__sub" role="status" data-record-outcome>
              {form.outcome}
            </p>
          )}
          <Button type="submit" variant="primary" busy={form.busy ? 'Recording…' : undefined}>
            Record incident
          </Button>
        </form>
      </Card>
    </div>
  );
}
