// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal, the per-client region (MP-14-10a): the client scope
// bar, 010 Graduation with its standing approvals, and the per-client halves
// of 011 Channels and 012 Exceptions, made-up rows under the mock label until
// MP-14-10b builds their reads (`client-mock.tsx`).
//
// One read, `connection.graduation`, brings every client the caller may see,
// so the one select drives all three sections as view state and asks the
// server nothing (CS-14.16). It is read as the signal sections are: through
// `useRead` and `RecordState`, keyed on the grant and re-read on the rollup
// floor. A row's state comes from the server, derived from the live mandates
// there; the switch moves only a class that is ready or promoted. Promoting
// asks for the ceiling and expiry its standing mandate needs (owner answer
// 13); demoting sends one command, and revoking waits on a confirmation
// first. Every command goes through `useMoneyCommand`, since mandate:manage
// needs a fresh sign-in (C59), says its refusal in the server's words, and
// reads the region again; a form clears only once its write succeeds. A write held for that
// sign-in locks every form until it settles, and is withdrawn when the client changes, the last
// client leaves or its form is cancelled; one whose answer was lost goes again under its operation.
//
// The chosen client and every client's forms are kept above the read (`graduation-drafts.ts`),
// so an outage gives them back; a standing approval files under its draft id, one per intent.

import { useState, type ReactElement } from 'react';
import { Empty, SectionHead } from '@launchastro/ui';
import type {
  ConnectionGraduationResult,
  GraduationRowView,
  MandateView,
} from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import type { RollupFloor } from '../../data/rollup-floor.ts';
import { useRead } from '../../data/use-read.ts';
import type { StepUpAsk } from '../../records/use-money-command.ts';
import { RecordState } from '../../views/record-state.tsx';
import { StepUpPrompt } from '../../views/step-up-prompt.tsx';
import { ChannelsMock, ExceptionsMock } from './client-mock.tsx';
import {
  GraduationDrafts,
  useChosenClient,
  useMandateDraft,
  useLeftEmpty,
  useOpenPromotion,
} from './graduation-drafts.ts';
import { MandateForm } from './graduation-forms.tsx';
import { ConfirmRevokeMandate, GraduationRow, Mandate, promoted } from './graduation-rows.tsx';
import { promotionOf, useSend, type Drop, type Send } from './graduation-send.ts';

type Client = ConnectionGraduationResult['clients'][number];

function ScopeBar(props: {
  readonly clients: readonly Client[];
  readonly chosen: string;
  readonly choose: (id: string) => void;
}): ReactElement {
  return (
    <div className="gradbar" data-client-scope>
      <label className="gradbar__l" htmlFor="client-scope">
        Client scope
      </label>
      <select
        id="client-scope"
        value={props.chosen}
        onChange={(event) => props.choose(event.target.value)}
      >
        {props.clients.map((one) => (
          <option key={one.id} value={one.id}>
            {one.label}
          </option>
        ))}
      </select>
      <span className="approval__meta">
        Everything above this bar describes the fleet. Everything below it describes one client.
      </span>
    </div>
  );
}

function StandingApprovals(props: {
  readonly client: Client;
  readonly mandates: readonly MandateView[];
  readonly rows: readonly GraduationRowView[];
  readonly drafts: GraduationDrafts;
  readonly send: Send;
  readonly locked: boolean;
}): ReactElement {
  const { client, send, locked } = props;
  const [revoking, setRevoking] = useState<MandateView | null>(null);
  const form = useMandateDraft(props.drafts, client.id, send);
  return (
    <div className="card">
      <div className="card__title">Standing approvals</div>
      <div className="card__sub">
        Classes and a ceiling picked from lists, an expiry, and the sentence as its label
      </div>
      {revoking === null ? null : (
        <ConfirmRevokeMandate
          mandate={revoking}
          holds={props.rows.filter((row) => row.heldBy === revoking.id)}
          onKeep={() => setRevoking(null)}
          locked={locked}
          onRevoke={() => {
            setRevoking(null);
            send('mandate.revoke', { mandateId: revoking.id }, revoking.revision);
          }}
        />
      )}
      <div className="pslist">
        {props.mandates.length === 0 ? (
          <p className="approval__meta">No standing approval or refusal for this client.</p>
        ) : (
          props.mandates.map((one) => (
            <Mandate key={one.id} mandate={one} locked={locked} revoke={() => setRevoking(one)} />
          ))
        )}
      </div>
      <MandateForm key={client.id} scopes={client.scopes} {...form} locked={locked} />
      <p className="approval__meta">
        Core checks the classes, client, ceiling, expiry and revocation at every effect; nothing
        reads the sentence.
      </p>
    </div>
  );
}

function Graduation(props: {
  readonly client: Client;
  readonly rows: readonly GraduationRowView[];
  readonly mandates: readonly MandateView[];
  readonly drafts: GraduationDrafts;
  readonly send: Send;
  readonly drop: Drop;
  readonly locked: boolean;
}): ReactElement {
  const { client, drafts, send } = props;
  const promoting = useOpenPromotion(drafts, client.id);
  const flip = (row: GraduationRowView): void => {
    if (promoted(row)) send('graduation.demote', { classId: row.id }, row.revision);
    else drafts.openPromotion(client.id, row.id);
  };
  return (
    <div className="card card--flush">
      <div className="grad">
        {props.rows.map((row) => (
          <GraduationRow
            key={row.id}
            row={row}
            holder={props.mandates.find((one) => one.id === row.heldBy)?.label ?? null}
            clientLabel={client.label}
            promoting={promoting?.classId === row.id ? promoting : null}
            edit={(change) => drafts.editPromotion(client.id, change)}
            locked={props.locked}
            flip={() => flip(row)}
            promote={(filing) => {
              send(
                'graduation.promote',
                { classId: row.id, ...filing },
                row.revision,
                (settled) => {
                  if (settled.kind === 'ok') drafts.closePromotion(client.id, row.id);
                },
              );
            }}
            cancel={() => {
              props.drop(promotionOf(row.id));
              drafts.closePromotion(client.id, row.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** The last refusal, in the server's words, and the prompt for a fresh sign-in. */
function Notices(props: {
  readonly said: string | null;
  readonly stepUp: StepUpAsk | null;
}): ReactElement {
  return (
    <>
      {props.said === null ? null : (
        <p role="alert" data-region-said>
          {props.said}
        </p>
      )}
      {props.stepUp === null ? null : <StepUpPrompt ask={props.stepUp} />}
    </>
  );
}

/** 011 and 012 for the chosen client: made-up rows under the mock label. */
function ClientMocks(props: { readonly scoped: ReactElement }): ReactElement {
  return (
    <>
      <section className="gradsec" data-section="011" data-mock="channels">
        <SectionHead index="011" title="Channels" right={props.scoped} />
        <ChannelsMock />
      </section>
      <section className="gradsec" data-section="012" data-mock="exceptions">
        <SectionHead index="012" title="Exceptions" right={props.scoped} />
        <ExceptionsMock />
      </section>
    </>
  );
}

function Shown(props: {
  readonly region: ConnectionGraduationResult;
  readonly drafts: GraduationDrafts;
  readonly send: Send;
  readonly drop: Drop;
  readonly said: string | null;
  readonly locked: boolean;
  readonly stepUp: StepUpAsk | null;
}): ReactElement | null {
  const { region, drafts, send, locked } = props;
  const [client, selectClient] = useChosenClient(region.clients, drafts, props.drop);
  if (client === undefined) return null;
  const rows = region.rows.filter((one) => one.clientId === client.id);
  const mandates = region.mandates.filter((one) => one.clientId === client.id);
  const scoped = <span data-scope-client>{client.label}</span>;
  return (
    <>
      <ScopeBar clients={region.clients} chosen={client.id} choose={selectClient} />
      <section className="gradsec" data-section="010" id="graduation">
        <SectionHead index="010" title="Graduation" right={scoped} />
        <Notices said={props.said} stepUp={props.stepUp} />
        <Graduation
          key={client.id}
          client={client}
          rows={rows}
          mandates={mandates}
          drafts={drafts}
          send={send}
          drop={props.drop}
          locked={locked}
        />
        <StandingApprovals
          key={`approvals-${client.id}`}
          client={client}
          mandates={mandates}
          rows={rows}
          drafts={drafts}
          send={send}
          locked={locked}
        />
      </section>
      <ClientMocks scoped={scoped} />
    </>
  );
}

export function GraduationRegion(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly rollup?: RollupFloor;
}): ReactElement {
  const { client } = props;
  const { state, reload } = useRead<ConnectionGraduationResult>({
    grantKey: props.grantKey,
    run: () => client.read<ConnectionGraduationResult>('connection.graduation', {}),
    isEmpty: (value) => value.clients.length === 0,
    ...(props.rollup === undefined ? {} : { rollup: props.rollup }),
    deps: [],
  });
  const { command, send, drop } = useSend(client, reload);
  // Above the read, so an outage keeps it; the region's key is the grant's.
  const [drafts] = useState(() => new GraduationDrafts());
  useLeftEmpty(drafts, state.outcome === 'empty', drop);
  return (
    <div className="secs" data-graduation>
      <RecordState
        state={state}
        subject="per-client region"
        onRetry={reload}
        keep
        empty={
          <Empty
            title="No client you can see yet."
            description="Each client joins the scope bar once it is created."
          />
        }
      >
        {(region) => (
          <Shown
            region={region}
            drafts={drafts}
            send={send}
            drop={drop}
            said={command.because}
            locked={command.locked || command.stepUp !== null}
            stepUp={command.stepUp}
          />
        )}
      </RecordState>
    </div>
  );
}
