// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers (C33, C52-A): each automation with its
// activations, each showing its mode, the version it is pinned to and the
// standing approval it names.
//
// The panel reads `automation.registry` and writes through each change's own
// command, sending back the revision the registry showed, so a change made
// elsewhere in between is refused rather than overwritten: switching to manual
// (`activation.change`, `settings:manage`), and adopting a newer version,
// rolling back, revoking the approval and turning off (C52-A, each
// `automation:manage`). Rollback and revocation are two controls. The server
// refuses anyone without the key, and the refusal is shown as it came.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type {
  ActivationView,
  AutomationDefinitionView,
  AutomationRegistryResult,
  CommandName,
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

function approvalOf(activation: ActivationView): string {
  const { approval } = activation;
  if (approval === null) return 'not approved to run';
  if (approval.revoked) return 'approval revoked';
  return approval.act === 'rolled_back' ? 'rolled back, approved to run' : 'approved to run';
}

type Change = (command: CommandName, body: Readonly<Record<string, unknown>>) => void;

function useRegistry(client: OperationsClient): {
  readonly listing: Listing;
  readonly because: string | null;
  readonly change: (command: CommandName, body: Readonly<Record<string, unknown>>) => Promise<void>;
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

  const change = async (
    command: CommandName,
    body: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const answer = await client.mutate(command, body);
    if (isUnavailable(answer)) setBecause(answer.because);
    else if (isRefusal(answer)) setBecause(`${answer.code}: ${answer.names.join(', ')}`);
    else setBecause(null);
    await load();
  };

  return { listing, because, change };
}

/** The newest version that permits the activation's mode, if newer than the pin. */
function newerOf(
  definition: AutomationDefinitionView,
  activation: ActivationView,
): AutomationDefinitionView['versions'][number] | undefined {
  return definition.versions
    .filter((version) => version.modes.includes(activation.mode))
    .findLast((version) => version.number > activation.versionNumber);
}

/** A newer version to adopt; with none, the pinned one to approve as it is; or null. */
function adoptOf(
  definition: AutomationDefinitionView,
  activation: ActivationView,
  standing: boolean,
): { readonly versionId: string; readonly label: string } | null {
  const newer = newerOf(definition, activation);
  if (newer !== undefined) return { versionId: newer.id, label: `Adopt v${String(newer.number)}` };
  if (standing || !activation.enabled) return null;
  return {
    versionId: activation.versionId,
    label: `Approve v${String(activation.versionNumber)}`,
  };
}

const controlButton = (control: string, label: string, run: () => void): ReactElement => (
  <button key={control} type="button" data-control={control} onClick={run}>
    {label}
  </button>
);

function Controls(props: {
  readonly definition: AutomationDefinitionView;
  readonly activation: ActivationView;
  readonly change: Change;
}): ReactElement {
  const { activation, change } = props;
  const { approval } = activation;
  const at = { activationId: activation.id, expectedRevision: activation.revision };
  const standing = approval !== null && !approval.revoked;
  const adopt = adoptOf(props.definition, activation, standing);
  return (
    <>
      {activation.mode === 'manual'
        ? null
        : controlButton('manual', 'Switch to manual', () => {
            change('activation.change', {
              ...at,
              versionId: activation.versionId,
              mode: 'manual',
              enabled: activation.enabled,
            });
          })}
      {adopt === null
        ? null
        : controlButton('adopt', adopt.label, () => {
            change('activation.adopt', { ...at, versionId: adopt.versionId });
          })}
      {activation.versionNumber > 1
        ? controlButton('roll-back', 'Roll back', () => {
            change('activation.roll_back', at);
          })
        : null}
      {standing
        ? controlButton('revoke', 'Revoke approval', () => {
            change('approval.revoke', { approvalId: approval.id });
          })
        : null}
      {activation.enabled
        ? controlButton('turn-off', 'Turn off', () => {
            change('activation.turn_off', at);
          })
        : null}
    </>
  );
}

function Definition(props: {
  readonly definition: AutomationDefinitionView;
  readonly change: Change;
}): ReactElement {
  const { definition } = props;
  return (
    <li data-definition={definition.id}>
      <span className="sb__k">{definition.name}</span>{' '}
      <span className="card__sub">{definition.kind}</span>
      <ul className="stack">
        {definition.activations.map((activation) => (
          <li
            key={activation.id}
            data-activation={activation.id}
            data-mode={activation.mode}
            data-enabled={String(activation.enabled)}
          >
            <span data-trigger="mode">{modeOf(activation)}</span>{' '}
            <span data-trigger="version">pinned to v{activation.versionNumber}</span>{' '}
            <span>{activation.enabled ? 'on' : 'off'}</span>{' '}
            <span data-trigger="approval">{approvalOf(activation)}</span>{' '}
            <Controls definition={definition} activation={activation} change={props.change} />
          </li>
        ))}
      </ul>
    </li>
  );
}

export function TriggersPanel(props: { readonly client: OperationsClient }): ReactElement {
  const { listing, because, change } = useRegistry(props.client);
  return (
    <section className="sb__sect" data-settings="triggers">
      <div className="sb__sh">
        <span className="sb__k">Workflow triggers</span>
      </div>
      <p className="card__sub">
        Each automation runs by hand, on a schedule or on an event, always on the version it is
        pinned to. Turning one to a schedule or an event starts nothing until a person adopts that
        version, which approves it to run; revoking the approval or turning the automation off stops
        the next run.
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
              change={(command, body) => {
                void change(command, body);
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
