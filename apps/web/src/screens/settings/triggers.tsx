// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers (C33, C52-A): one list card, a page row per
// activation, each showing its automation, its mode, the version it is pinned
// to and the standing approval it names (the row is `triggers-row.tsx`).
//
// The panel reads `automation.registry` and writes through each control's own
// command, sending back the revision the registry showed, so a change made
// elsewhere in between is refused rather than overwritten. The server refuses
// anyone without the command's key, and the refusal is shown as it came.
//
// One press is one attempt: its `operationId` is held while its answer is
// unknown, so pressing again after a lost answer sends the same attempt and the
// server replays what it did. Only the newest registry read is drawn, and a new
// client (another business) starts the panel empty, dropping whatever the last
// one still had in flight, its answers to changes included.

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type {
  AutomationDefinitionView,
  AutomationRegistryResult,
  CapabilitiesResult,
} from '../../../../../packages/core-wire/src/index.ts';
import type { ReadState } from '../../data/authorised-read.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { DefinitionRows, type TriggerCommand } from './triggers-row.tsx';

type Listing =
  | { readonly state: 'loading' }
  | { readonly state: 'shown'; readonly definitions: readonly AutomationDefinitionView[] }
  | { readonly state: 'refused'; readonly because: string }
  | { readonly state: 'unavailable'; readonly because: string };

/** Whether the capability read says this session holds `settings:read`. */
export function seesTriggers(capabilities: ReadState<CapabilitiesResult>): boolean {
  return (
    (capabilities.outcome === 'ready' || capabilities.outcome === 'empty') &&
    capabilities.value.grants.some(
      (grant) => grant.collection === 'settings' && grant.action === 'read',
    )
  );
}

/** The newest registry read for this client; an answer to an older read or client is dropped. */
function useListing(client: OperationsClient): {
  readonly listing: Listing;
  readonly load: () => Promise<void>;
  readonly current: { readonly current: OperationsClient };
} {
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const latest = useRef(0);
  const current = useRef(client);
  current.current = client;

  const load = useCallback(async (): Promise<void> => {
    latest.current += 1;
    const mine = latest.current;
    const answer = await client.read<AutomationRegistryResult>('automation.registry', {});
    if (mine !== latest.current || current.current !== client) return;
    if (isUnavailable(answer)) setListing({ state: 'unavailable', because: answer.because });
    else if (isRefusal(answer))
      setListing({ state: 'refused', because: answer.fixes[0] ?? answer.code });
    else setListing({ state: 'shown', definitions: answer.value.definitions });
  }, [client]);

  useEffect(() => {
    setListing({ state: 'loading' });
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  return { listing, load, current };
}

interface Registry {
  readonly listing: Listing;
  readonly because: string | null;
  readonly busy: boolean;
  readonly change: (
    command: TriggerCommand,
    body: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
}

function useRegistry(client: OperationsClient): Registry {
  const { listing, load, current } = useListing(client);
  const [because, setBecause] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The attempt each unanswered press made, by the command and body it sent.
  const held = useRef(new Map<string, string>());

  useEffect(() => {
    setBecause(null);
    setBusy(false);
    held.current = new Map();
  }, [client]);

  const change = async (
    command: TriggerCommand,
    body: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const key = JSON.stringify([command, body]);
    const operationId = held.current.get(key) ?? client.newOperationId();
    held.current.set(key, operationId);
    setBusy(true);
    const answer = await client.mutate(command, body, { operationId });
    if (current.current !== client) return;
    if (!isUnavailable(answer)) held.current.delete(key);
    setBusy(false);
    if (isUnavailable(answer)) setBecause(answer.because);
    else if (isRefusal(answer)) setBecause(`${answer.code}: ${answer.names.join(', ')}`);
    else setBecause(null);
    await load();
  };

  return { listing, because, busy, change };
}

/** The card's head: what a trigger is and what starts one. */
function TriggersHead(): ReactElement {
  return (
    <div className="card__head">
      <div>
        <h3 className="card__title">Workflow triggers</h3>
        <p className="card__sub">
          Each automation runs by hand, on a schedule or on an event, always on the version it is
          pinned to. Turning one to a schedule or an event starts nothing until a person adopts that
          version, which approves it to run; revoking the approval or turning the automation off
          stops the next run.
        </p>
      </div>
    </div>
  );
}

export function TriggersPanel(props: { readonly client: OperationsClient }): ReactElement {
  const { listing, because, busy, change } = useRegistry(props.client);
  return (
    <section className="card card--flush" data-settings="triggers">
      <TriggersHead />
      {listing.state === 'loading' ? <p className="triggers__note">Reading triggers…</p> : null}
      {listing.state === 'refused' ? (
        <Empty
          title="You are not permitted to see the workflow triggers."
          description={listing.because}
        />
      ) : null}
      {listing.state === 'unavailable' ? (
        <p className="field__error triggers__note" role="status">
          {listing.because}
        </p>
      ) : null}
      {listing.state === 'shown' && listing.definitions.length === 0 ? (
        <Empty title="No automations yet." description="A released automation shows here." />
      ) : null}
      {listing.state === 'shown' && listing.definitions.length > 0 ? (
        <ul className="triggers__list" data-settings="trigger-rows">
          {listing.definitions.map((definition) => (
            <DefinitionRows
              key={definition.id}
              definition={definition}
              busy={busy}
              change={(command, body) => {
                void change(command, body);
              }}
            />
          ))}
        </ul>
      ) : null}
      {because === null ? null : (
        <p className="field__error triggers__note" role="alert" data-settings="triggers-refusal">
          {because}
        </p>
      )}
    </section>
  );
}
