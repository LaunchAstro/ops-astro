// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers (C33): each automation with its activations,
// each showing its mode and the version it is pinned to.
//
// The panel reads `automation.registry` and writes through `activation.change`,
// sending back the revision the registry showed, so a change made elsewhere in
// between is refused rather than overwritten. Switching to manual is the one
// change drawn here; the server refuses anyone without `settings:manage`, and
// the refusal is shown as it came.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type {
  ActivationView,
  AutomationDefinitionView,
  AutomationRegistryResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';

type Listing =
  | { readonly state: 'loading' }
  | { readonly state: 'shown'; readonly definitions: readonly AutomationDefinitionView[] }
  | { readonly state: 'refused'; readonly because: string }
  | { readonly state: 'unavailable'; readonly because: string };

function modeOf(activation: ActivationView): string {
  if (activation.mode === 'scheduled') {
    return `scheduled, every ${String(activation.everyMinutes)} minutes`;
  }
  if (activation.mode === 'event') return `on ${String(activation.eventKind)}`;
  return 'manual';
}

function useRegistry(client: OperationsClient): {
  readonly listing: Listing;
  readonly because: string | null;
  readonly toManual: (activation: ActivationView) => Promise<void>;
} {
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const [because, setBecause] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const answer = await client.read<AutomationRegistryResult>('automation.registry', {});
    if (isUnavailable(answer)) setListing({ state: 'unavailable', because: answer.because });
    else if (isRefusal(answer))
      setListing({ state: 'refused', because: answer.fixes[0] ?? answer.code });
    else setListing({ state: 'shown', definitions: answer.value.definitions });
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const toManual = async (activation: ActivationView): Promise<void> => {
    const answer = await client.mutate('activation.change', {
      activationId: activation.id,
      versionId: activation.versionId,
      mode: 'manual',
      enabled: activation.enabled,
      expectedRevision: activation.revision,
    });
    if (isUnavailable(answer)) setBecause(answer.because);
    else if (isRefusal(answer)) setBecause(`${answer.code}: ${answer.names.join(', ')}`);
    else setBecause(null);
    await load();
  };

  return { listing, because, toManual };
}

function Definition(props: {
  readonly definition: AutomationDefinitionView;
  readonly toManual: (activation: ActivationView) => void;
}): ReactElement {
  const { definition } = props;
  return (
    <li data-definition={definition.id}>
      <span className="sb__k">{definition.name}</span>{' '}
      <span className="card__sub">{definition.kind}</span>
      <ul className="stack">
        {definition.activations.map((activation) => (
          <li key={activation.id} data-activation={activation.id} data-mode={activation.mode}>
            <span data-trigger="mode">{modeOf(activation)}</span>{' '}
            <span data-trigger="version">pinned to v{activation.versionNumber}</span>{' '}
            <span>{activation.enabled ? 'on' : 'off'}</span>{' '}
            {activation.mode === 'manual' ? null : (
              <button
                type="button"
                data-control="manual"
                onClick={() => {
                  props.toManual(activation);
                }}
              >
                Switch to manual
              </button>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function TriggersPanel(props: { readonly client: OperationsClient }): ReactElement {
  const { listing, because, toManual } = useRegistry(props.client);
  return (
    <section className="sb__sect" data-settings="triggers">
      <div className="sb__sh">
        <span className="sb__k">Workflow triggers</span>
      </div>
      <p className="card__sub">
        Each automation runs by hand, on a schedule or on an event, always on the version it is
        pinned to. Turning one to a schedule or an event starts nothing until its version is
        approved to run.
      </p>
      {listing.state === 'loading' ? <p className="card__sub">Reading triggers…</p> : null}
      {listing.state === 'refused' ? (
        <Empty
          title="You are not permitted to see the workflow triggers."
          description={listing.because}
        />
      ) : null}
      {listing.state === 'unavailable' ? (
        <p className="field__error" role="status">
          {listing.because}
        </p>
      ) : null}
      {listing.state === 'shown' && listing.definitions.length === 0 ? (
        <Empty title="No automations yet." description="A released automation shows here." />
      ) : null}
      {listing.state === 'shown' ? (
        <ul className="stack" data-settings="trigger-rows">
          {listing.definitions.map((definition) => (
            <Definition
              key={definition.id}
              definition={definition}
              toManual={(activation) => {
                void toManual(activation);
              }}
            />
          ))}
        </ul>
      ) : null}
      {because === null ? null : (
        <p className="field__error" role="alert" data-settings="triggers-refusal">
          {because}
        </p>
      )}
    </section>
  );
}
