// SPDX-License-Identifier: AGPL-3.0-only
//
// A new client's onboarding, laid out as tasks in phases (C41-A, CS-15.2 and
// CS-15.4). It draws no mockup surface: it is built from the kit alone. Each
// step says whether an agent runs it, it needs a person or it waits on the
// client, what it waits for, and what it wrote onto its task. A step parked
// at a gate names whose move it is.
//
// There is no onboarding read yet (`onboarding.start` and
// `onboarding.step_result` are commands), so every value below is made up and
// sits inside the kit's one mock label (DS-PRIM-32). It is started from the
// command palette or the CLI until the Clients board and the client workspace
// place its button, so the page places none.

import type { ReactElement } from 'react';
import { Card, Chip, MockRegion } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import {
  MADE_UP_ONBOARDING,
  type OnboardingStepView,
  type OnboardingView,
  type StepKind,
} from './onboarding/made-up.ts';

const KIND: Readonly<Record<StepKind, string>> = {
  agent: 'Agent runs it',
  person: 'Needs a person',
  client: 'Waits on the client',
};

function stateWords(step: OnboardingStepView): string {
  if (step.state === 'done') return 'Done';
  if (step.state === 'stopped') return 'Stopped after two failures';
  if (step.state === 'blocked') return 'Waiting on an earlier step';
  return step.owner === null ? 'Ready' : `Parked at its gate: the ${step.owner}'s move`;
}

function Step(props: {
  readonly step: OnboardingStepView;
  readonly titleOf: (key: string) => string;
}): ReactElement {
  const { step } = props;
  return (
    <li className="list-row" data-step={step.key}>
      <p>
        <strong>{step.title}</strong>{' '}
        <span data-step-kind>
          <Chip kind="outline">{KIND[step.kind]}</Chip>
        </span>
      </p>
      <p className="t-2" data-step-state>
        {stateWords(step)}
      </p>
      {step.dependsOn.length === 0 ? null : (
        <p className="t-2" data-step-after>
          After {step.dependsOn.map(props.titleOf).join(', ')}
        </p>
      )}
      {step.result === null ? null : <p data-step-result>{step.result}</p>}
    </li>
  );
}

function Phases(props: { readonly onboarding: OnboardingView }): ReactElement {
  const { onboarding } = props;
  const phases = [...new Set(onboarding.steps.map((step) => step.phase))];
  const titleOf = (key: string): string =>
    onboarding.steps.find((step) => step.key === key)?.title ?? key;
  return (
    <>
      <p data-onboarding-client>
        <strong>{onboarding.client}</strong>{' '}
        <span className="t-2">from the template {onboarding.template}</span>
      </p>
      {phases.map((phase) => (
        <div key={phase} data-onboarding-phase={phase}>
          <Card title={phase} flush>
            <ul className="stack">
              {onboarding.steps
                .filter((step) => step.phase === phase)
                .map((step) => (
                  <Step key={step.key} step={step} titleOf={titleOf} />
                ))}
            </ul>
          </Card>
        </div>
      ))}
    </>
  );
}

export function OnboardingScreen(_props: { readonly client: OperationsClient }): ReactElement {
  return (
    <section className="page" data-screen="onboarding" data-onboarding>
      <header className="page__head">
        <h1>Onboarding</h1>
        <p className="t-2">Start one from the command palette or the CLI.</p>
      </header>
      <MockRegion word>
        <Phases onboarding={MADE_UP_ONBOARDING} />
      </MockRegion>
    </section>
  );
}
