// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's Client select (MP-4-8, CS-4.12, DP-19).
//
// **Changed only while the task is empty.** An empty task's client is chosen
// from the business's client list and goes through `task.set_party`
// (`task:share`) at the revision the panel read, in one step; a change that
// lands is counted, a refusal (`CLIENT_LOCKED` included) is quoted in the
// server's words. Once the task has content the select is drawn locked in the
// same look, with DP-19's line and "Duplicate without contents", which opens
// `DuplicateForm.tsx` for another client.
//
// **Its sources are seams.** The client list, which client the task is under,
// whether it has content, and the duplicate's sender come through
// `client-seam.ts`; an absent one is the made-up one. A made-up source draws
// the one Mock corner label (`SourceRegion`) over what it fills; a real one
// draws nothing extra.

import { useState, type ReactElement } from 'react';
import { SourceRegion } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';
import { useCommand } from '../../records/use-command.ts';
import { RecordState } from '../../views/record-state.tsx';
import {
  MOCK_CLIENT_FACTS,
  MOCK_DUPLICATE,
  type ClientSeams,
  type DuplicateSource,
  type TaskClientFacts,
} from './client-seam.ts';
import { DuplicateForm } from './DuplicateForm.tsx';

export const LOCKED_LINE =
  'This task has content, so its client is locked. Duplicate it without contents to start one for another client.';

export interface ClientFieldProps extends ClientSeams {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly task: Task;
  readonly onChanged: () => void;
}

function ClientSelect(props: {
  readonly facts: TaskClientFacts;
  readonly busy: boolean;
  readonly onChoose: (client: string) => void;
}): ReactElement {
  const { choices, current, hasContent } = props.facts;
  const unseen = current !== null && !choices.some((choice) => choice.id === current);
  return (
    <select
      id="panel-field-client"
      className="input"
      disabled={hasContent || props.busy}
      value={current ?? ''}
      onChange={(event) => props.onChoose(event.target.value)}
    >
      <option value="" disabled>
        No client
      </option>
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.name}
        </option>
      ))}
      {unseen ? (
        <option value={current} disabled>
          A client you cannot see
        </option>
      ) : null}
    </select>
  );
}

/** The select, and once the task has content, DP-19's line and the action. */
function ClientValue(props: {
  readonly facts: TaskClientFacts;
  readonly busy: boolean;
  readonly duplicating: boolean;
  readonly onChoose: (client: string) => void;
  readonly onDuplicate: () => void;
}): ReactElement {
  return (
    <>
      <ClientSelect facts={props.facts} busy={props.busy} onChoose={props.onChoose} />
      {props.facts.hasContent ? (
        <>
          <p className="field__hint">{LOCKED_LINE}</p>
          <button
            className="btn"
            type="button"
            data-panel-field="duplicate"
            aria-expanded={props.duplicating}
            onClick={props.onDuplicate}
          >
            Duplicate without contents
          </button>
        </>
      ) : null}
    </>
  );
}

/** One client change through `task.set_party` at the read revision; a landed one is counted. */
function useSetParty(props: ClientFieldProps, current: string | null) {
  const { busy, because, run } = useCommand();
  const choose = (party: string): void => {
    if (party === '' || party === current) return;
    run(
      () =>
        props.client.mutate(
          'task.set_party',
          { recordId: props.task.id, fields: { client: party } },
          { expectedRevision: props.task.revision },
        ),
      (settlement) => {
        if (settlement.kind === 'ok') props.onChanged();
      },
    );
  };
  return { busy, because, choose };
}

/** The form for another client, under its sender's provenance; `onDone(null)` is Cancel. */
function DuplicateSection(props: {
  readonly task: Task;
  readonly facts: TaskClientFacts;
  readonly duplicate: DuplicateSource;
  readonly onDone: (key: string | null) => void;
}): ReactElement {
  const { facts } = props;
  return (
    <div data-duplicate-form>
      <SourceRegion provenance={props.duplicate.provenance}>
        <DuplicateForm
          task={props.task}
          choices={facts.choices.filter((choice) => choice.id !== facts.current)}
          send={props.duplicate.send}
          onDuplicated={props.onDone}
          onCancel={() => props.onDone(null)}
        />
      </SourceRegion>
    </div>
  );
}

export function ClientField(props: ClientFieldProps): ReactElement {
  const source = props.clientFacts ?? MOCK_CLIENT_FACTS;
  const duplicate = props.duplicate ?? MOCK_DUPLICATE;
  const facts = source.useFacts(props.task, props.grantKey);
  const known = 'value' in facts.state ? facts.state.value : null;
  const { busy, because, choose } = useSetParty(props, known?.current ?? null);
  const [duplicating, setDuplicating] = useState(false);
  return (
    <>
      <label className="tf__k" htmlFor="panel-field-client">
        Client
      </label>
      <div data-panel-field="client">
        <SourceRegion provenance={source.provenance}>
          <RecordState state={facts.state} subject="clients" onRetry={facts.reload}>
            {(value) => (
              <ClientValue
                facts={value}
                busy={busy}
                duplicating={duplicating}
                onChoose={choose}
                onDuplicate={() => setDuplicating(true)}
              />
            )}
          </RecordState>
        </SourceRegion>
      </div>
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
      {duplicating && known !== null ? (
        <DuplicateSection
          task={props.task}
          facts={known}
          duplicate={duplicate}
          onDone={(key) => {
            setDuplicating(false);
            if (key !== null) props.onDuplicated?.(key);
          }}
        />
      ) : null}
    </>
  );
}
