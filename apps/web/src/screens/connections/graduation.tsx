// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal, the per-client region (MP-14-10a): the client scope
// bar, 010 Graduation with its standing approvals, and the per-client halves
// of 011 Channels and 012 Exceptions, which MP-14-10b draws.
//
// One read, `connection.graduation`, brings every client the caller may see,
// so the one select drives all three sections as view state and asks the
// server nothing (CS-14.16). A row's state comes from the server, derived from
// the live mandates there; the switch moves only a class that is ready or
// promoted. Promoting asks for the ceiling and expiry its standing mandate
// needs (owner answer 13); demoting and revoking send one command each.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { InDevelopment } from '@launchastro/ui';
import type {
  ConnectionGraduationResult,
  GraduationRowView,
  MandateView,
} from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { MandateForm, type MandateFiling } from './graduation-forms.tsx';
import { GraduationRow, Mandate } from './graduation-rows.tsx';

type Change = 'mandate.file' | 'mandate.revoke' | 'graduation.promote' | 'graduation.demote';
type Send = (name: Change, body: Readonly<Record<string, unknown>>, revision?: number) => void;
type Client = ConnectionGraduationResult['clients'][number];

type Region =
  | { readonly state: 'loading' }
  | { readonly state: 'shown'; readonly region: ConnectionGraduationResult }
  | { readonly state: 'absent'; readonly because: string };

/** The region's one read, and each change followed by that read again. */
function useRegion(client: OperationsClient): {
  readonly region: Region;
  readonly send: Send;
  readonly said: string | null;
} {
  const [region, setRegion] = useState<Region>({ state: 'loading' });
  const [said, setSaid] = useState<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    const answer = await client.read<ConnectionGraduationResult>('connection.graduation', {});
    if (isUnavailable(answer)) setRegion({ state: 'absent', because: answer.because });
    else if (isRefusal(answer))
      setRegion({ state: 'absent', because: answer.fixes[0] ?? answer.code });
    else setRegion({ state: 'shown', region: answer.value });
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  const send: Send = (name, body, revision) => {
    void (async () => {
      const options = revision === undefined ? {} : { expectedRevision: revision };
      const answer = await client.mutate(name, body, options);
      if (isUnavailable(answer)) setSaid(answer.because);
      else if (isRefusal(answer)) setSaid(`${answer.code}: ${answer.fixes[0] ?? ''}`);
      else setSaid(null);
      await load();
    })();
  };
  return { region, send, said };
}

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
    <div className="card mt-4">
      <div className="card__title">Standing approvals</div>
      <div className="card__sub">
        Classes and a ceiling picked from lists, an expiry, and the sentence as its label
      </div>
      <div className="pslist mt-3">
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
      <p className="approval__meta mt-2">
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
    <div className="card card--flush mt-4">
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
}): ReactElement {
  const { region, send } = props;
  const [chosen, choose] = useState(region.clients[0]?.id ?? '');
  const client = region.clients.find((one) => one.id === chosen) ?? region.clients[0];
  if (client === undefined) {
    return <p className="approval__meta">No client has a graduation record yet.</p>;
  }
  const scoped = (
    <span className="t-2" data-scope-client>
      {client.label}
    </span>
  );
  return (
    <>
      <ScopeBar clients={region.clients} chosen={client.id} choose={choose} />
      <section data-section="010" id="graduation">
        <h2>010 Graduation {scoped}</h2>
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
      <section data-section="011" data-not-connected="channels">
        <h2>011 Channels {scoped}</h2>
        <InDevelopment title="Channels for this client" owner="MP-14-10b" />
      </section>
      <section data-section="012" data-not-connected="exceptions">
        <h2>012 Exceptions {scoped}</h2>
        <InDevelopment title="Exceptions for this client" owner="MP-14-10b" />
      </section>
    </>
  );
}

export function GraduationRegion(props: { readonly client: OperationsClient }): ReactElement {
  const { region, send, said } = useRegion(props.client);
  if (region.state === 'loading') return <p role="status">Loading the per-client region…</p>;
  if (region.state === 'absent') return <p className="approval__meta">{region.because}</p>;
  return <Shown region={region.region} send={send} said={said} />;
}
