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
// Four writes, each the command the server checks under `access:manage`:
// `access.grant` gives one person one key over the business or one client;
// `access.revoke` ends one grant, by the id the read lists, once confirmed;
// `access.end` ends a person's access in one act (their login, every session
// and their grants), sent only once it is confirmed; `delegation.revoke` ends
// an agent's, by its delegation. After each, the list is read again: the
// preview on the page is always the server's, never this screen's guess.
// A refusal is shown in the server's words and changes nothing on the page.

import { useState, type ReactElement } from 'react';
import { useRead } from '../data/use-read.ts';
import type { OperationsClient } from '../operations/client.ts';
import { describeFailure, type SubmitResult } from '../records/submit.ts';
import { RecordState } from '../views/record-state.tsx';
import type { AccessReadResult, PersonView } from '../../../../packages/core-wire/src/index.ts';
import { ConfirmEnd, ConfirmRevokeGrant, GiveAccess, type Revoking } from './access/acts.tsx';
import { Agents, People } from './access/rows.tsx';

export interface AccessScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
}

/** One write, then the list read again; a refusal changes nothing but the outcome line. */
type Act = (send: () => Promise<SubmitResult>, done: string) => void;

const revokeWith =
  (client: OperationsClient, act: Act) =>
  (agent: AccessReadResult['agents'][number]): void => {
    act(
      () => client.mutate('delegation.revoke', { delegationId: agent.delegationId }),
      `Revoked the delegation for ${agent.purpose}.`,
    );
  };

const giveWith =
  (client: OperationsClient, act: Act) =>
  (holder: PersonView, key: string, clientId: string | null): void => {
    const [collection, action] = key.split(':');
    const body = { holderId: holder.personId, collection, action, clientId };
    act(() => client.mutate('access.grant', body), `Gave ${holder.name} ${key}.`);
  };

/**
 * The two acts that wait on a confirmation before anything is sent: ending a
 * person's access (`access.end`) and revoking one grant (`access.revoke`).
 */
function usePending(client: OperationsClient, act: Act) {
  const [ending, setEnding] = useState<PersonView | null>(null);
  const [revoking, setRevoking] = useState<Revoking | null>(null);
  const endAccess = (person: PersonView): void => {
    setEnding(null);
    act(
      () => client.mutate('access.end', { holderId: person.personId }),
      `Ended ${person.name}'s access: their login, sessions and grants.`,
    );
  };
  const revokeGrant = ({ person, grant }: Revoking): void => {
    setRevoking(null);
    act(
      () => client.mutate('access.revoke', { grantId: grant.grantId }),
      `Revoked ${person.name}'s ${grant.collection}:${grant.action}.`,
    );
  };
  const confirmations = (result: AccessReadResult): ReactElement => (
    <>
      {revoking === null ? null : (
        <ConfirmRevokeGrant
          revoking={revoking}
          result={result}
          onKeep={() => setRevoking(null)}
          onRevoke={() => revokeGrant(revoking)}
        />
      )}
      {ending === null ? null : (
        <ConfirmEnd
          person={ending}
          onKeep={() => setEnding(null)}
          onEnd={() => endAccess(ending)}
        />
      )}
    </>
  );
  const onRevokeGrant = (person: PersonView, grant: Revoking['grant']): void =>
    setRevoking({ person, grant });
  return { confirmations, onEnd: setEnding, onRevokeGrant };
}

function AccessLists(props: {
  readonly client: OperationsClient;
  readonly result: AccessReadResult;
  readonly busy: boolean;
  readonly act: Act;
  readonly outcome: ReactElement | null;
}): ReactElement {
  const { client, result, act } = props;
  const { confirmations, onEnd, onRevokeGrant } = usePending(client, act);
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
          <Agents result={result} onRevoke={revokeWith(client, act)} />
        </div>
      </section>
      <section className="sec">
        <GiveAccess result={result} busy={props.busy} onGive={giveWith(client, act)} />
      </section>
    </>
  );
}

export function AccessScreen(props: AccessScreenProps): ReactElement {
  const { client, grantKey } = props;
  const { state, reload } = useRead<AccessReadResult>({
    grantKey,
    run: () => client.read<AccessReadResult>('access.read', {}),
    deps: [client],
  });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const act: Act = (send, done) => {
    setBusy(true);
    void (async () => {
      const failure = describeFailure(await send());
      setBusy(false);
      setOutcome(failure ?? done);
      if (failure === null) reload();
    })();
  };
  // The top bar names the page; the body is the page kit's sections (PAGE-MAP SH-40 to 44).
  return (
    <div className="secs" data-screen="access" data-business={client.businessKey}>
      <RecordState state={state} subject="access list" onRetry={reload}>
        {(result) => (
          <div className="secs">
            <AccessLists
              client={client}
              result={result}
              busy={busy}
              act={act}
              outcome={
                outcome === null ? null : (
                  <p className="card__sub" role="status" data-access-outcome>
                    {outcome}
                  </p>
                )
              }
            />
          </div>
        )}
      </RecordState>
    </div>
  );
}
