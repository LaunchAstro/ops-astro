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
// 13); demoting and revoking send one command each. Every command goes
// through `useCommand`, says its refusal in the server's words, and reads the
// region again.

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
import { useCommand } from '../../records/use-command.ts';
import { RecordState } from '../../views/record-state.tsx';
import { ChannelsMock, ExceptionsMock } from './client-mock.tsx';
import { MandateForm, type MandateFiling } from './graduation-forms.tsx';
import { GraduationRow, Mandate } from './graduation-rows.tsx';

type Change = 'mandate.file' | 'mandate.revoke' | 'graduation.promote' | 'graduation.demote';
type Send = (name: Change, body: Readonly<Record<string, unknown>>, revision?: number) => void;
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
  readonly send: Send;
}): ReactElement {
  const { client, send } = props;
  const file = (mandate: MandateFiling): void => {
    send('mandate.file', { clientId: client.id, ...mandate });
  };
  return (
    <div className="card">
      <div className="card__title">Standing approvals</div>
      <div className="card__sub">
        Classes and a ceiling picked from lists, an expiry, and the sentence as its label
      </div>
      <div className="pslist">
        {props.mandates.length === 0 ? (
          <p className="approval__meta">No standing approval or refusal for this client.</p>
        ) : (
          props.mandates.map((one) => (
            <Mandate
              key={one.id}
              mandate={one}
              revoke={() => send('mandate.revoke', { mandateId: one.id }, one.revision)}
            />
          ))
        )}
      </div>
      <MandateForm key={client.id} scopes={client.scopes} file={file} />
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
  readonly send: Send;
}): ReactElement {
  const { client, send } = props;
  const [promoting, setPromoting] = useState<string | null>(null);
  const flip = (row: GraduationRowView): void => {
    if (row.state === 'promoted') send('graduation.demote', { classId: row.id }, row.revision);
    else setPromoting(row.id);
  };
  return (
    <div className="card card--flush">
      <div className="grad">
        {props.rows.map((row) => (
          <GraduationRow
            key={row.id}
            row={row}
            clientLabel={client.label}
            promoting={promoting === row.id}
            flip={() => flip(row)}
            promote={(filing) => {
              setPromoting(null);
              send('graduation.promote', { classId: row.id, ...filing }, row.revision);
            }}
            cancel={() => setPromoting(null)}
          />
        ))}
      </div>
    </div>
  );
}

function Shown(props: {
  readonly region: ConnectionGraduationResult;
  readonly send: Send;
  readonly said: string | null;
}): ReactElement | null {
  const { region, send } = props;
  const [chosen, choose] = useState(region.clients[0]?.id ?? '');
  const client = region.clients.find((one) => one.id === chosen) ?? region.clients[0];
  if (client === undefined) return null;
  const scoped = <span data-scope-client>{client.label}</span>;
  return (
    <>
      <ScopeBar clients={region.clients} chosen={client.id} choose={choose} />
      <section className="gradsec" data-section="010" id="graduation">
        <SectionHead index="010" title="Graduation" right={scoped} />
        {props.said === null ? null : (
          <p role="alert" data-region-said>
            {props.said}
          </p>
        )}
        <Graduation
          key={client.id}
          client={client}
          rows={region.rows.filter((one) => one.clientId === client.id)}
          send={send}
        />
        <StandingApprovals
          client={client}
          mandates={region.mandates.filter((one) => one.clientId === client.id)}
          send={send}
        />
      </section>
      <section className="gradsec" data-section="011" data-mock="channels">
        <SectionHead index="011" title="Channels" right={scoped} />
        <ChannelsMock />
      </section>
      <section className="gradsec" data-section="012" data-mock="exceptions">
        <SectionHead index="012" title="Exceptions" right={scoped} />
        <ExceptionsMock />
      </section>
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
  const command = useCommand();
  const send: Send = (name, body, revision) => {
    command.run(
      () => client.mutate(name, body, revision === undefined ? {} : { expectedRevision: revision }),
      reload,
    );
  };
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
        {(region) => <Shown region={region} send={send} said={command.because} />}
      </RecordState>
    </div>
  );
}
