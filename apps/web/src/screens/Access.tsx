// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings/access/`: Settings ▸ Access (C32), and C58's act on it.
//
// Team, Clients and Agents come from one read, `access.read`, which is one
// list of people underneath all three (RC-22): this screen keeps no people list
// of its own. Each row shows what the grant check would allow that person now,
// over the whole business, one client or one record, and names a client only
// from the read's own client records. A scope the read does not list is said
// as that, never by its identifier.
//
// C60's client privacy card is a fifth write, `client.set_privacy`, under
// `privacy:manage`; its refusals are drawn like the others.
//
// Four writes, each the command the server checks under `access:manage`:
// `access.grant` gives one person one key over the business or one client;
// `access.revoke` ends one grant, by the id the read lists, once confirmed;
// `access.end` ends a person's access in one act (their login, every session
// and their grants), sent only once it is confirmed; `delegation.revoke` ends
// an agent's, by its delegation, also once confirmed. After each, the list is read again: the
// preview on the page is always the server's, never this screen's guess.
// A refusal is shown in the server's words and changes nothing on the page.
// One write is out at a time. The last write whose answer was lost goes again
// under its operation id only when the same act is pressed again, so the
// server replays what it stored; any other act, or a known answer, ends it.

import { useRef, useState, type ReactElement } from 'react';
import { useRead } from '../data/use-read.ts';
import type { OperationsClient } from '../operations/client.ts';
import { describeFailure } from '../records/submit.ts';
import { settle } from '../records/use-command.ts';
import { RecordState } from '../views/record-state.tsx';
import type { AccessReadResult, PersonView } from '../../../../packages/core-wire/src/index.ts';
import {
  ConfirmEnd,
  ConfirmRevokeDelegation,
  ConfirmRevokeGrant,
  GiveAccess,
  type Revoking,
} from './access/acts.tsx';
import { ClientPrivacy } from './access/privacy.tsx';
import { Agents, People } from './access/rows.tsx';

export interface AccessScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
}

/**
 * One write, then the list read again; a refusal changes nothing but the
 * outcome line. A write whose answer was lost is sent again under its own id.
 */
type Act = (command: AccessCommand, body: Readonly<Record<string, unknown>>, done: string) => void;

type Agent = AccessReadResult['agents'][number];

type AccessCommand =
  'delegation.revoke' | 'access.grant' | 'access.end' | 'access.revoke' | 'client.set_privacy';

const giveWith =
  (act: Act) =>
  (holder: PersonView, key: string, clientId: string | null): void => {
    const [collection, action] = key.split(':');
    const body = { holderId: holder.personId, collection, action, clientId };
    act('access.grant', body, `Gave ${holder.name} ${key}.`);
  };

/** A refusal is drawn as Settings draws one; a success stays a quiet line. */
const Outcome = (props: { readonly text: string; readonly refused: boolean }): ReactElement =>
  props.refused ? (
    <p className="field__error" role="alert" data-access-outcome="refused">
      {props.text}
    </p>
  ) : (
    <p className="card__sub" role="status" data-access-outcome="done">
      {props.text}
    </p>
  );

/** The three confirmed writes, each sent once its confirmation is pressed. */
const confirmedWith = (act: Act) => ({
  end: (person: PersonView): void => {
    act(
      'access.end',
      { holderId: person.personId },
      `Ended ${person.name}'s access: their login, sessions and grants.`,
    );
  },
  revokeGrant: ({ person, grant }: Revoking): void => {
    act(
      'access.revoke',
      { grantId: grant.grantId },
      `Revoked ${person.name}'s ${grant.collection}:${grant.action}.`,
    );
  },
  revokeDelegation: (agent: Agent): void => {
    act(
      'delegation.revoke',
      { delegationId: agent.delegationId },
      `Revoked the delegation for ${agent.purpose}.`,
    );
  },
});

/**
 * The three acts that wait on a confirmation before anything is sent: ending a
 * person's access (`access.end`), revoking one grant (`access.revoke`) and
 * revoking an agent's delegation (`delegation.revoke`).
 */
function usePending(act: Act) {
  const [ending, setEnding] = useState<PersonView | null>(null);
  const [revoking, setRevoking] = useState<Revoking | null>(null);
  const [delegation, setDelegation] = useState<Agent | null>(null);
  const send = confirmedWith(act);
  const confirmations = (result: AccessReadResult): ReactElement => (
    <>
      {delegation === null ||
      !result.agents.some((agent) => agent.delegationId === delegation.delegationId) ? null : (
        <ConfirmRevokeDelegation
          agent={delegation}
          onKeep={() => setDelegation(null)}
          onRevoke={() => {
            setDelegation(null);
            send.revokeDelegation(delegation);
          }}
        />
      )}
      {revoking === null ? null : (
        <ConfirmRevokeGrant
          revoking={revoking}
          result={result}
          onKeep={() => setRevoking(null)}
          onRevoke={() => {
            setRevoking(null);
            send.revokeGrant(revoking);
          }}
        />
      )}
      {ending === null ? null : (
        <ConfirmEnd
          person={ending}
          onKeep={() => setEnding(null)}
          onEnd={() => {
            setEnding(null);
            send.end(ending);
          }}
        />
      )}
    </>
  );
  const onRevokeGrant = (person: PersonView, grant: Revoking['grant']): void =>
    setRevoking({ person, grant });
  return { confirmations, onEnd: setEnding, onRevokeGrant, onRevokeDelegation: setDelegation };
}

function AccessLists(props: {
  readonly client: OperationsClient;
  readonly result: AccessReadResult;
  readonly busy: boolean;
  readonly act: Act;
  readonly outcome: ReactElement | null;
}): ReactElement {
  const { client, result, act } = props;
  const { confirmations, onEnd, onRevokeGrant, onRevokeDelegation } = usePending(act);
  const clients = result.clientRecords;
  const lists = { clients, onEnd, onRevokeGrant };
  return (
    <>
      <section className="sec">
        <h2 className="sec__head">Who may do what</h2>
        <p className="card__sub">In {client.businessKey}, as the server grants it now.</p>
        {props.outcome}
        <div className="stack" data-access-lists>
          {confirmations(result)}
          <People id="team" title="Team" people={result.team} {...lists} />
          <People id="clients" title="Clients" people={result.clients} {...lists} />
          <Agents result={result} onRevoke={onRevokeDelegation} />
        </div>
      </section>
      <section className="sec">
        <GiveAccess result={result} busy={props.busy} onGive={giveWith(act)} />
      </section>
      <section className="sec">
        <ClientPrivacy
          result={result}
          busy={props.busy}
          onSet={(body, name) =>
            act('client.set_privacy', body, `Saved ${name}'s privacy settings.`)
          }
        />
      </section>
    </>
  );
}

/** One write at a time, its outcome line, and the list read again after a success. */
function useAct(client: OperationsClient, reload: () => void) {
  const [busy, setBusy] = useState(false);
  // One write at a time: a second press before the answer sends nothing.
  const sending = useRef(false);
  const [outcome, setOutcome] = useState<{ text: string; refused: boolean } | null>(null);
  // The last write whose answer was lost: its act and its operation id.
  const held = useRef<{ readonly act: string; readonly id: string } | null>(null);
  const act: Act = (command, body, done) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    const words = JSON.stringify([command, body]);
    const id = held.current?.act === words ? held.current.id : client.newOperationId();
    held.current = { act: words, id };
    void (async () => {
      const answer = await client.mutate(command, body, { operationId: id });
      if (settle(answer).kind !== 'unknown') held.current = null;
      const failure = describeFailure(answer);
      sending.current = false;
      setBusy(false);
      setOutcome({ text: failure ?? done, refused: failure !== null });
      if (failure === null) reload();
    })();
  };
  return { busy, outcome, act };
}

export function AccessScreen(props: AccessScreenProps): ReactElement {
  const { client, grantKey } = props;
  const { state, reload } = useRead<AccessReadResult>({
    grantKey,
    run: () => client.read<AccessReadResult>('access.read', {}),
    deps: [client],
  });
  const { busy, outcome, act } = useAct(client, reload);
  // The top bar names the page; the body is the page kit's sections (PAGE-MAP SH-40 to 44).
  return (
    <div className="secs" data-screen="access" data-business={client.businessKey}>
      <p className="card__sub" data-page-lead>
        Who may do what in {client.businessKey}, as the server grants it now.
      </p>
      <RecordState state={state} subject="access list" onRetry={reload}>
        {(result) => (
          <div className="secs">
            <AccessLists
              client={client}
              result={result}
              busy={busy}
              act={act}
              outcome={outcome === null ? null : <Outcome {...outcome} />}
            />
          </div>
        )}
      </RecordState>
    </div>
  );
}
