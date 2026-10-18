// SPDX-License-Identifier: AGPL-3.0-only
//
// One activation's history on Settings ▸ Workflow triggers (#1741), opened
// from its row: what fired or was refused and the changes people made, newest
// first, from `automation.history`, 50 at a time with a button for older ones.
// The server sends codes; this page words them. Built from the shared kit's
// table, chips and buttons. A refusal is shown as it came.

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Chip, Table, type MarkTone } from '@launchastro/ui';
import type {
  AutomationHistoryEntry,
  AutomationHistoryResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';

/** Each occurrence outcome in words, and the tone of its chip. */
const OUTCOMES: Readonly<Record<string, readonly [string, MarkTone]>> = {
  approved: ['Approved to run', 'ok'],
  started: ['Run started', 'ok'],
  activation_off: ['Automation was off', 'idle'],
  no_standing_approval: ['Not approved for this version', 'warn'],
  over_activation_rate: ['Over this automation’s hourly limit', 'warn'],
  over_business_rate: ['Over the business’s hourly limit', 'warn'],
  over_intake_bound: ['Over the event queue limit', 'warn'],
};

/** What dispatch found, worded; an approved occurrence with none is still waiting. */
const DISPATCHES: Readonly<Record<string, string>> = {
  started: 'run started',
  activation_off: 'off by the time it was due to start',
  approval_revoked: 'approval revoked before it started',
  approval_ended: 'approval ended before it started',
};

const CHANGES: Readonly<Record<string, string>> = {
  'activation.change': 'Changed the trigger',
  'activation.adopt': 'Adopted a version',
  'activation.roll_back': 'Rolled back',
  'activation.turn_off': 'Turned off',
  'approval.revoke': 'Revoked the approval',
};

const WHEN = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' });

const COLUMNS = [
  { key: 'when', label: 'When' },
  { key: 'what', label: 'What' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'by', label: 'By or run' },
] as const;

function byOf(entry: AutomationHistoryEntry): string {
  if (entry.kind === 'occurrence') return entry.runId ?? '';
  if (entry.actorName !== null) return entry.actorName;
  return entry.actorKind === 'agent' ? 'An agent' : 'Someone no longer here';
}

function outcomeOf(entry: AutomationHistoryEntry): ReactElement | string {
  if (entry.kind === 'change') return '';
  const [words, tone] = OUTCOMES[entry.outcome] ?? [entry.outcome, 'idle'];
  const dispatch =
    entry.dispatch === null
      ? entry.outcome === 'approved'
        ? 'waiting to start'
        : null
      : (DISPATCHES[entry.dispatch] ?? entry.dispatch);
  return (
    <>
      <Chip kind="soft" tone={tone}>
        {words}
      </Chip>
      {dispatch === null ? null : ` ${dispatch}`}
    </>
  );
}

function rowOf(entry: AutomationHistoryEntry): Readonly<Record<string, ReactElement | string>> {
  const what =
    entry.kind === 'change'
      ? (CHANGES[entry.command] ?? entry.command)
      : entry.cause.kind === 'event'
        ? 'An event'
        : `Due ${WHEN.format(new Date(entry.cause.dueAt))}`;
  return {
    when: (
      <time data-entry={entry.id} dateTime={entry.at}>
        {WHEN.format(new Date(entry.at))}
      </time>
    ),
    what,
    outcome: outcomeOf(entry),
    by: byOf(entry),
  };
}

type Shown =
  | { readonly state: 'loading' }
  | {
      readonly state: 'shown';
      readonly entries: readonly AutomationHistoryEntry[];
      readonly next: string | null;
    }
  | { readonly state: 'refused'; readonly because: string };

/** The history's pages so far; `older` reads the next with the cursor the last gave. */
function useHistory(
  client: OperationsClient,
  activationId: string,
): { readonly shown: Shown; readonly older: () => void } {
  const [shown, setShown] = useState<Shown>({ state: 'loading' });
  const live = useRef(true);
  // One page read at a time: a second press while one is out sends nothing.
  const reading = useRef(false);
  const read = useCallback(
    async (before: Shown): Promise<void> => {
      if (reading.current) return;
      reading.current = true;
      const cursor = before.state === 'shown' ? before.next : null;
      const body = cursor === null ? { activationId } : { activationId, cursor };
      const answer = await client.read<AutomationHistoryResult>('automation.history', body);
      reading.current = false;
      if (!live.current) return;
      if (isUnavailable(answer)) setShown({ state: 'refused', because: answer.because });
      else if (isRefusal(answer)) {
        setShown({ state: 'refused', because: answer.fixes[0] ?? answer.code });
      } else {
        const earlier = before.state === 'shown' ? before.entries : [];
        setShown({
          state: 'shown',
          entries: [...earlier, ...answer.value.entries],
          next: answer.value.next,
        });
      }
    },
    [client, activationId],
  );
  useEffect(() => {
    live.current = true;
    void read({ state: 'loading' });
    return () => {
      live.current = false;
    };
  }, [read]);
  return {
    shown,
    older: () => {
      void read(shown);
    },
  };
}

/** The history drawn under its activation's row. */
export function ActivationHistory(props: {
  readonly client: OperationsClient;
  readonly activationId: string;
}): ReactElement {
  const { shown, older } = useHistory(props.client, props.activationId);
  return (
    <li className="triggers__note" data-history={props.activationId}>
      {shown.state === 'loading' ? <p role="status">Reading the history…</p> : null}
      {shown.state === 'refused' ? (
        <p className="field__error" role="alert">
          {shown.because}
        </p>
      ) : null}
      {shown.state === 'shown' && shown.entries.length === 0 ? (
        <p>Nothing has fired or changed yet.</p>
      ) : null}
      {shown.state === 'shown' && shown.entries.length > 0 ? (
        <Table
          caption="History"
          columns={COLUMNS}
          rows={shown.entries.map((entry) => rowOf(entry))}
          dense
        />
      ) : null}
      {shown.state === 'shown' && shown.next !== null ? (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          data-control="history-older"
          onClick={older}
        >
          Show older
        </button>
      ) : null}
    </li>
  );
}
