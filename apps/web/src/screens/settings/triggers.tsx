// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers (C33): one list card, a page row per
// activation, each showing its automation, its mode and the version it is
// pinned to.
//
// The panel reads `automation.registry` and writes through `activation.change`,
// sending back the revision the registry showed, so a change made elsewhere in
// between is refused rather than overwritten. Switching to manual is the one
// change drawn here; the server refuses anyone without `settings:manage`, and
// the refusal is shown as it came.
//
// One press is one attempt: its `operationId` is held while its answer is
// unknown, so pressing again after a lost answer sends the same attempt and the
// server replays what it did. Only the newest registry read is drawn, and a new
// client (another business) starts the panel empty, dropping whatever the last
// one still had in flight.

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type {
  ActivationView,
  AutomationDefinitionView,
  AutomationRegistryResult,
  CapabilitiesResult,
} from '../../../../../packages/core-wire/src/index.ts';
import type { ReadState } from '../../data/authorised-read.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';

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

function modeOf(activation: ActivationView): string {
  if (activation.mode === 'scheduled') {
    return `scheduled, every ${String(activation.everyMinutes)} minutes`;
  }
  if (activation.mode === 'event') return `on ${String(activation.eventKind)}`;
  return 'manual';
}

const KIND = { automation: 'Automation', skill: 'Skill' } as const;

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
  readonly toManual: (activation: ActivationView) => Promise<void>;
}

function useRegistry(client: OperationsClient): Registry {
  const { listing, load, current } = useListing(client);
  const [because, setBecause] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The attempt each unanswered press made, by the body it sent.
  const held = useRef(new Map<string, string>());

  useEffect(() => {
    setBecause(null);
    setBusy(false);
    held.current = new Map();
  }, [client]);

  const toManual = async (activation: ActivationView): Promise<void> => {
    const body = {
      activationId: activation.id,
      versionId: activation.versionId,
      mode: 'manual',
      enabled: activation.enabled,
      expectedRevision: activation.revision,
    };
    const key = JSON.stringify(body);
    const operationId = held.current.get(key) ?? client.newOperationId();
    held.current.set(key, operationId);
    setBusy(true);
    const answer = await client.mutate('activation.change', body, { operationId });
    if (current.current !== client) return;
    if (!isUnavailable(answer)) held.current.delete(key);
    setBusy(false);
    if (isUnavailable(answer)) setBecause(answer.because);
    else if (isRefusal(answer)) setBecause(`${answer.code}: ${answer.names.join(', ')}`);
    else setBecause(null);
    await load();
  };

  return { listing, because, busy, toManual };
}

/** One activation's page row: its automation, mode, pin and switch. */
function ActivationRow(props: {
  readonly definition: AutomationDefinitionView;
  readonly activation: ActivationView;
  readonly busy: boolean;
  readonly toManual: (activation: ActivationView) => void;
}): ReactElement {
  const { definition, activation } = props;
  return (
    <li
      className="lrow lrow--page"
      data-definition={definition.id}
      data-activation={activation.id}
      data-mode={activation.mode}
    >
      <span className="lrow__main">
        <span className="lrow__title">{definition.name}</span>
        <span className="lrow__meta">
          {KIND[definition.kind]} · <span data-trigger="mode">{modeOf(activation)}</span> ·{' '}
          <span data-trigger="version">pinned to v{activation.versionNumber}</span> ·{' '}
          {activation.enabled ? 'on' : 'off'}
        </span>
      </span>
      <span className="lrow__trail">
        {activation.mode === 'manual' ? null : (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            data-control="manual"
            disabled={props.busy}
            onClick={() => {
              props.toManual(activation);
            }}
          >
            Switch to manual
          </button>
        )}
      </span>
    </li>
  );
}

/** One page row per activation; a definition with none still draws its row. */
function Definition(props: {
  readonly definition: AutomationDefinitionView;
  readonly busy: boolean;
  readonly toManual: (activation: ActivationView) => void;
}): ReactElement {
  const { definition } = props;
  if (definition.activations.length === 0) {
    return (
      <li className="lrow lrow--page" data-definition={definition.id}>
        <span className="lrow__main">
          <span className="lrow__title">{definition.name}</span>
          <span className="lrow__meta">{KIND[definition.kind]} · no activation</span>
        </span>
      </li>
    );
  }
  return (
    <>
      {definition.activations.map((activation) => (
        <ActivationRow key={activation.id} {...props} activation={activation} />
      ))}
    </>
  );
}

/** The card's head: what a trigger is and what starts one. */
function TriggersHead(): ReactElement {
  return (
    <div className="card__head">
      <div>
        <h3 className="card__title">Workflow triggers</h3>
        <p className="card__sub">
          Each automation runs by hand, on a schedule or on an event, always on the version it is
          pinned to. Turning one to a schedule or an event starts nothing until its version is
          approved to run.
        </p>
      </div>
    </div>
  );
}

export function TriggersPanel(props: { readonly client: OperationsClient }): ReactElement {
  const { listing, because, busy, toManual } = useRegistry(props.client);
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
            <Definition
              key={definition.id}
              definition={definition}
              busy={busy}
              toManual={(activation) => {
                void toManual(activation);
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
