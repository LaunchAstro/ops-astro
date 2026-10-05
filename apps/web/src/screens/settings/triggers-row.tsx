// SPDX-License-Identifier: AGPL-3.0-only
//
// One page row of Settings ▸ Workflow triggers (C33, C52-A): the automation,
// its mode, the version it is pinned to, the standing approval it names as a
// chip, and its controls. Split from `triggers.tsx`, which reads and writes.
//
// Each control is one command at the revision the registry showed: switching
// to manual (`activation.change`, `settings:manage`), and adopting a newer
// version or approving the pinned one, rolling back, revoking the approval
// and turning off (each `automation:manage`). Rollback and revocation are two
// controls. The server refuses anyone without the key.

import type { ReactElement } from 'react';
import { Chip } from '@launchastro/ui';
import type {
  ActivationView,
  AutomationDefinitionView,
} from '../../../../../packages/core-wire/src/index.ts';

/** The writes a row's controls send, each its own command. */
export type TriggerCommand =
  | 'activation.change'
  | 'activation.adopt'
  | 'activation.roll_back'
  | 'activation.turn_off'
  | 'approval.revoke';

export type Change = (command: TriggerCommand, body: Readonly<Record<string, unknown>>) => void;

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

function approvalTone(activation: ActivationView): 'ok' | 'warn' | 'idle' {
  const { approval } = activation;
  if (approval === null) return 'idle';
  return approval.revoked ? 'warn' : 'ok';
}

const KIND = { automation: 'Automation', skill: 'Skill' } as const;

/** A newer version that permits the mode to adopt; with none, the pin to approve as it is; or null. */
function adoptOf(
  definition: AutomationDefinitionView,
  activation: ActivationView,
  standing: boolean,
): { readonly versionId: string; readonly label: string } | null {
  // Only an automation that is on is approved: no adoption while off.
  if (!activation.enabled) return null;
  const newer = definition.versions
    .filter((version) => version.modes.includes(activation.mode))
    .findLast((version) => version.number > activation.versionNumber);
  if (newer !== undefined) return { versionId: newer.id, label: `Adopt v${String(newer.number)}` };
  if (standing) return null;
  return {
    versionId: activation.versionId,
    label: `Approve v${String(activation.versionNumber)}`,
  };
}

interface Control {
  readonly control: string;
  readonly label: string;
  readonly command: TriggerCommand;
  readonly body: Readonly<Record<string, unknown>>;
}

/** The controls a row draws, in order, each with the command and body it sends. */
function controlsOf(definition: AutomationDefinitionView, activation: ActivationView): Control[] {
  const { approval } = activation;
  const at = { activationId: activation.id, expectedRevision: activation.revision };
  const standing = approval !== null && !approval.revoked;
  const adopt = adoptOf(definition, activation, standing);
  const controls: Control[] = [];
  if (activation.mode !== 'manual') {
    const body = { ...at, versionId: activation.versionId, mode: 'manual' };
    controls.push({
      control: 'manual',
      label: 'Switch to manual',
      command: 'activation.change',
      body: { ...body, enabled: activation.enabled },
    });
  }
  if (adopt !== null) {
    const body = { ...at, versionId: adopt.versionId };
    controls.push({ control: 'adopt', label: adopt.label, command: 'activation.adopt', body });
  }
  // Only an automation that is on is approved: no roll back while off.
  if (activation.versionNumber > 1 && activation.enabled) {
    controls.push({
      control: 'roll-back',
      label: 'Roll back',
      command: 'activation.roll_back',
      body: at,
    });
  }
  if (standing) {
    const body = { approvalId: approval.id };
    controls.push({
      control: 'revoke',
      label: 'Revoke approval',
      command: 'approval.revoke',
      body,
    });
  }
  if (activation.enabled) {
    controls.push({
      control: 'turn-off',
      label: 'Turn off',
      command: 'activation.turn_off',
      body: at,
    });
  }
  return controls;
}

function Controls(props: {
  readonly definition: AutomationDefinitionView;
  readonly activation: ActivationView;
  readonly busy: boolean;
  readonly change: Change;
}): ReactElement {
  return (
    <>
      {controlsOf(props.definition, props.activation).map(({ control, label, command, body }) => (
        <button
          key={control}
          type="button"
          className="btn btn--secondary btn--sm"
          data-control={control}
          disabled={props.busy}
          onClick={() => {
            props.change(command, body);
          }}
        >
          {label}
        </button>
      ))}
    </>
  );
}

/** One activation's page row: its automation, mode, pin, switch, approval and controls. */
export function ActivationRow(props: {
  readonly definition: AutomationDefinitionView;
  readonly activation: ActivationView;
  readonly busy: boolean;
  readonly change: Change;
}): ReactElement {
  const { definition, activation } = props;
  return (
    <li
      className="lrow lrow--page"
      data-definition={definition.id}
      data-activation={activation.id}
      data-mode={activation.mode}
      data-enabled={String(activation.enabled)}
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
        <Chip kind="soft" tone={approvalTone(activation)}>
          <span data-trigger="approval">{approvalOf(activation)}</span>
        </Chip>
        <Controls {...props} />
      </span>
    </li>
  );
}

/** One page row per activation; a definition with none still draws its row. */
export function DefinitionRows(props: {
  readonly definition: AutomationDefinitionView;
  readonly busy: boolean;
  readonly change: Change;
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
