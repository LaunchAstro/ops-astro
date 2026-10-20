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
// an agent's, by its delegation, also once confirmed. After each, the list is
// read again: the preview on the page is always the server's, never this
// screen's guess. A refusal is shown in the server's words and changes nothing
// on the page. The last of these writes whose answer was lost goes again under
// its operation id only when the same act is pressed again, so the server
// replays what it stored; any other act, or a known answer, ends it.
//
// C39-T's: "Invite a team member" sends `invitation.create` under
// `access:share`, drawn only when `session.capabilities` says the session
// holds that key (`access/invite.tsx`); the server still refuses anyone else.
// Under it, the business's invitations from `invitation.list`, each pending
// one with `invitation.resend` and `invitation.revoke` (`access/invitations.tsx`).
// It sits beside the access list, not inside it: `access.read` asks
// `access:manage`, and a holder of `access:share` alone still invites. An
// administrator's invitation, made or resent, also asks `access:manage`:
// without it the role is not offered and such a resend is not drawn.
// Each section has its own outcome line and holds one act at a time.
//
// API-2's agent credential (U18) is its own section, drawn only when
// `session.capabilities` says the session holds `credential:write`
// (`access/credential.tsx`). A business or person switch answers that read
// loading, so the section goes and its secret and what it made go with it.

import { useState, type ReactElement } from 'react';
import { useRead } from '../data/use-read.ts';
import type { OperationsClient } from '../operations/client.ts';
import type { SubmitResult } from '../records/submit.ts';
import { RecordState } from '../views/record-state.tsx';
import type {
  AccessReadResult,
  CapabilitiesResult,
  PersonView,
} from '../../../../packages/core-wire/src/index.ts';
import {
  ConfirmEnd,
  ConfirmRevokeDelegation,
  ConfirmRevokeGrant,
  GiveAccess,
  type Revoking,
} from './access/acts.tsx';
import { AgentCredential, holdsCredentialWrite } from './access/credential.tsx';
import { holdsAccess, InviteMember, type Invitation } from './access/invite.tsx';
import { Invitations, type InvitationAct } from './access/invitations.tsx';
import { ClientPrivacy } from './access/privacy.tsx';
import { Agents, People } from './access/rows.tsx';
import { useAct, useHeldSend, type Act, type Send } from './access/use-act.tsx';

export interface AccessScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
}

type Agent = AccessReadResult['agents'][number];

const giveWith =
  (send: Send, act: Act) =>
  (holder: PersonView, key: string, clientId: string | null): void => {
    const [collection, action] = key.split(':');
    const body = { holderId: holder.personId, collection, action, clientId };
    void act(() => send('access.grant', body), `Gave ${holder.name} ${key}.`);
  };

const inviteWith =
  (client: OperationsClient, act: Act) =>
  async (invitation: Invitation): Promise<SubmitResult | null> =>
    await act(
      () => client.mutate('invitation.create', { ...invitation }),
      `Invited ${invitation.name}. The invitation is pending until it is accepted, resent, revoked or expires.`,
    );

const actOnInvitationWith =
  (client: OperationsClient, act: Act): InvitationAct =>
  (command, invitation) => {
    const done = command === 'invitation.resend' ? 'Sent again' : 'Revoked';
    void act(
      () => client.mutate(command, { invitationId: invitation.invitationId }),
      `${done}: the invitation to ${invitation.name}.`,
    );
  };

/** Revoking an agent's delegation, sent once its confirmation is pressed. */
function usePendingDelegation(send: Send, act: Act) {
  const [delegation, setDelegation] = useState<Agent | null>(null);
  const revoke = (agent: Agent): void => {
    setDelegation(null);
    void act(
      () => send('delegation.revoke', { delegationId: agent.delegationId }),
      `Revoked the delegation for ${agent.purpose}.`,
    );
  };
  // A confirmation whose delegation a reread no longer lists closes.
  const confirmation = (result: AccessReadResult): ReactElement | null =>
    delegation === null ||
    !result.agents.some((agent) => agent.delegationId === delegation.delegationId) ? null : (
      <ConfirmRevokeDelegation
        agent={delegation}
        onKeep={() => setDelegation(null)}
        onRevoke={() => revoke(delegation)}
      />
    );
  return { confirmation, onRevokeDelegation: setDelegation };
}

/**
 * The three acts that wait on a confirmation before anything is sent: ending a
 * person's access (`access.end`), revoking one grant (`access.revoke`) and
 * revoking an agent's delegation (`delegation.revoke`).
 */
function usePending(send: Send, act: Act) {
  const [ending, setEnding] = useState<PersonView | null>(null);
  const [revoking, setRevoking] = useState<Revoking | null>(null);
  const endAccess = (person: PersonView): void => {
    setEnding(null);
    void act(
      () => send('access.end', { holderId: person.personId }),
      `Ended ${person.name}'s access: their login, sessions and grants.`,
    );
  };
  const revokeGrant = ({ person, grant }: Revoking): void => {
    setRevoking(null);
    void act(
      () => send('access.revoke', { grantId: grant.grantId }),
      `Revoked ${person.name}'s ${grant.collection}:${grant.action}.`,
    );
  };
  const delegation = usePendingDelegation(send, act);
  const confirmations = (result: AccessReadResult): ReactElement => (
    <>
      {delegation.confirmation(result)}
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
  return {
    confirmations,
    onEnd: setEnding,
    onRevokeGrant,
    onRevokeDelegation: delegation.onRevokeDelegation,
  };
}

function AccessLists(props: {
  readonly client: OperationsClient;
  readonly result: AccessReadResult;
  readonly busy: boolean;
  readonly act: Act;
  readonly outcome: ReactElement | null;
}): ReactElement {
  const { client, result, act } = props;
  const send = useHeldSend(client);
  const { confirmations, onEnd, onRevokeGrant, onRevokeDelegation } = usePending(send, act);
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
        <GiveAccess result={result} busy={props.busy} onGive={giveWith(send, act)} />
      </section>
      <section className="sec">
        <ClientPrivacy
          result={result}
          busy={props.busy}
          onSet={(body, name) =>
            act(() => send('client.set_privacy', body), `Saved ${name}'s privacy settings.`)
          }
        />
      </section>
    </>
  );
}

/** C39-T: the invitation form and the business's invitations, for a holder of `access:share`. */
function InviteSection(props: {
  readonly client: OperationsClient;
  readonly busy: boolean;
  readonly act: Act;
  readonly canManage: boolean;
  readonly grantKey: string;
  readonly version: number;
  readonly outcome: ReactElement | null;
}): ReactElement {
  const { client, act } = props;
  return (
    <section className="sec" data-access-section="invitations">
      {props.outcome}
      <InviteMember
        busy={props.busy}
        canInviteAdmin={props.canManage}
        onInvite={inviteWith(client, act)}
      />
      <Invitations
        client={client}
        grantKey={props.grantKey}
        version={props.version}
        onAct={actOnInvitationWith(client, act)}
        canManage={props.canManage}
        busy={props.busy}
      />
    </section>
  );
}

export function AccessScreen(props: AccessScreenProps): ReactElement {
  const { client, grantKey } = props;
  const { state, reload } = useRead<AccessReadResult>({
    grantKey,
    run: () => client.read<AccessReadResult>('access.read', {}),
    deps: [client],
  });
  const capabilities = useRead<CapabilitiesResult>({
    grantKey,
    run: () => client.read<CapabilitiesResult>('session.capabilities', {}),
    deps: [client],
  });
  const lists = useAct(reload);
  const invites = useAct(reload);
  // The top bar names the page; the body is the page kit's sections (PAGE-MAP SH-40 to 44).
  return (
    <div className="secs" data-screen="access" data-business={client.businessKey}>
      <p className="card__sub" data-page-lead>
        Who may do what in {client.businessKey}, as the server grants it now.
      </p>
      <RecordState state={state} subject="access list" onRetry={reload} keep>
        {(result) => (
          <div className="secs">
            <AccessLists
              client={client}
              result={result}
              busy={lists.busy}
              act={lists.act}
              outcome={lists.outcome}
            />
          </div>
        )}
      </RecordState>
      {holdsCredentialWrite(capabilities.state) ? <AgentCredential client={client} /> : null}
      {holdsAccess(capabilities.state, 'share') ? (
        <InviteSection
          client={client}
          busy={invites.busy}
          act={invites.act}
          canManage={holdsAccess(capabilities.state, 'manage')}
          grantKey={grantKey}
          version={invites.version}
          outcome={invites.outcome}
        />
      ) : null}
    </div>
  );
}
