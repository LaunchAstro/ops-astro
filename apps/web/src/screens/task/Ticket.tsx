// SPDX-License-Identifier: AGPL-3.0-only
//
// The ticket panel on a task page (WF-5): what makes a map's ticket more than
// a task. Its type, its map and the map's Destination, what blocks it and what
// it blocks, its gist once resolved, and the two writes a ticket adds: claim
// (`task.claim`, first come) and resolve (`task.resolve`, an answer and a
// one-line gist).
//
// **Drawn from `task.context`**, the one bundle the agent works from, at
// `full`; a part the reader may not read is absent there, so it is absent
// here. The thread is not drawn: it is the task's one comment record, which
// the page already shows (MP-4-5).
//
// **Resolve is offered where the server would allow it.** A grilling or
// prototype ticket is resolved by its map's owner only (WF-2), so the panel
// asks `session.capabilities` who is reading and offers Resolve to the owner
// alone. The server's refusal still stands behind it for anyone who sends it.

import { useState, type ReactElement } from 'react';
import type {
  CapabilitiesResult,
  CommandName,
  TicketContextResult,
} from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRead } from '../../data/use-read.ts';
import { useCommand, type Failure as Settled } from '../../records/use-command.ts';
import { needsKey } from '../../records/needs-key.ts';
import { pathTo } from '../../routes.ts';
import { TicketResolve } from './TicketResolve.tsx';

type Part = Readonly<Record<string, unknown>>;

const OWNER_RESOLVES = new Set(['grilling', 'prototype']);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export interface TicketPanelProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly recordId: string;
  /** A write applied: the page reads the task again. */
  readonly onChanged: () => void;
}

/** The ticket's bundle at full, and who is reading. */
function useTicketReads(client: OperationsClient, grantKey: string, recordId: string) {
  const bundle = useRead<TicketContextResult>({
    grantKey: grantKey,
    run: () =>
      client.read<TicketContextResult>('task.context', {
        recordId: recordId,
        detail: 'full',
      }),
    deps: [recordId],
  });
  const me = useRead<CapabilitiesResult>({
    grantKey: grantKey,
    run: () => client.read<CapabilitiesResult>('session.capabilities', {}),
    deps: [],
  });
  return { bundle, me };
}

/** The panel's writes: one at a time, each followed by the page's reread unless refused. */
function useTicketWrites(client: OperationsClient, onChanged: () => void) {
  const command = useCommand();
  const [sent, setSent] = useState<CommandName>('task.claim');
  const send = (ticket: Part, name: 'task.claim' | 'task.resolve', body: Part) => {
    setSent(name);
    command.run(
      () =>
        client.mutate(
          name,
          { recordId: text(ticket['id']), ...body },
          { expectedRevision: Number(ticket['revision']) },
        ),
      (settlement) => {
        if (settlement.kind === 'ok' || settlement.kind === 'stale') onChanged();
      },
    );
  };
  return { command, sent, send };
}

/**
 * What the panel offers this reader: claim while nobody holds an open ticket;
 * resolve while it is open, and on a grilling or prototype ticket only to its
 * map's owner (WF-2).
 */
function offers(
  context: TicketContextResult['context'],
  personId: string | null,
): { readonly done: boolean; readonly claim: boolean; readonly resolve: boolean } {
  const ticket = context.ticket;
  const done = ticket['completedAt'] !== null && ticket['completedAt'] !== undefined;
  const held = ticket['assignee'] !== null && ticket['assignee'] !== undefined;
  const owner = personId !== null && personId === context.map?.['owner'];
  return {
    done,
    claim: !done && !held,
    resolve: !done && (!OWNER_RESOLVES.has(text(ticket['type'])) || owner),
  };
}

export function TicketPanel(props: TicketPanelProps): ReactElement | null {
  const { client } = props;
  const { bundle, me } = useTicketReads(client, props.grantKey, props.recordId);
  const { command, sent, send } = useTicketWrites(client, props.onChanged);
  // Drawn once both have answered, so what it offers is decided, not pending.
  if (bundle.state.outcome !== 'ready' || me.state.outcome === 'loading') return null;
  const context = bundle.state.value.context as TicketContextResult['context'] | undefined;
  // An answer without a bundle (a server older than API-4) draws no panel.
  if (typeof context !== 'object' || typeof context.ticket !== 'object') return null;
  const ticket = context.ticket;
  // A task on no map is not a ticket: the page is the task page alone.
  if (context.map === undefined && text(ticket['type']) === 'task') return null;

  const offer = offers(context, me.state.outcome === 'ready' ? me.state.value.personId : null);
  const type = text(ticket['type']);
  return (
    <section className="sb__sect" data-ticket-panel="" data-type={type}>
      <div className="sb__sh">
        <span className="sb__k">Ticket · {type}</span>
      </div>
      <Failure failure={command.failure} sent={sent} />
      <MapLine map={context.map} />
      <Links label="Blocked by" attribute="data-blocked-by" parts={context.blockedBy} />
      <Links label="Blocks" attribute="data-blocks" parts={context.blocks} />
      {offer.done ? <p>Resolved: {text(ticket['gist'])}</p> : null}
      {offer.claim ? (
        <Claim
          busy={command.locked}
          onClaim={() => {
            send(ticket, 'task.claim', {});
          }}
        />
      ) : null}
      {offer.resolve ? (
        <TicketResolve
          busy={command.locked}
          onResolve={(answer, gist) => {
            send(ticket, 'task.resolve', { answer, gist });
          }}
        />
      ) : null}
    </section>
  );
}

function MapLine(props: {
  readonly map: TicketContextResult['context']['map'];
}): ReactElement | null {
  const map = props.map;
  if (map === undefined) return null;
  const key = text(map['key']);
  return (
    <p>
      On the map{' '}
      {key === '' ? (
        text(map['title'])
      ) : (
        <a href={pathTo('agency:map', { key })}>{text(map['title']) || key}</a>
      )}
      {text(map['destination']) === '' ? null : <> · Destination: {text(map['destination'])}</>}
    </p>
  );
}

function Links(props: {
  readonly label: string;
  readonly attribute: 'data-blocked-by' | 'data-blocks';
  readonly parts: readonly Part[];
}): ReactElement | null {
  if (props.parts.length === 0) return null;
  return (
    <p>
      {props.label}:{' '}
      {props.parts.map((part) => {
        const key = text(part['key']);
        const label = `${key} ${text(part['title'])}`.trim();
        return (
          <span key={text(part['id'])} {...{ [props.attribute]: text(part['id']) }}>
            {key === '' ? label : <a href={pathTo('agency:task-detail', { key })}>{label}</a>}{' '}
          </span>
        );
      })}
    </p>
  );
}

function Failure(props: {
  readonly failure: Settled | null;
  readonly sent: CommandName;
}): ReactElement | null {
  const failure = props.failure;
  if (failure === null) return null;
  return (
    <p className="field__error" role="alert" data-ticket-failure="">
      {failure.because} {needsKey(props.sent, 'refusal' in failure ? failure.refusal : undefined)}
    </p>
  );
}

function Claim(props: { readonly busy: boolean; readonly onClaim: () => void }): ReactElement {
  return (
    <div className="btnrow">
      <button
        className="btn"
        type="button"
        data-claim=""
        disabled={props.busy}
        onClick={props.onClaim}
      >
        Claim
      </button>
    </div>
  );
}
