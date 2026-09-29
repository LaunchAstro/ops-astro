// SPDX-License-Identifier: AGPL-3.0-only
//
// The onboarding templates (C41-A, CS-15.2). A template is a version in code:
// laying one out records its key and version on the onboarding, and a change
// is a new version, never an edit of one already used. Each step is a task on
// the client, in a phase, marked agent-run, needs a person, or waits on the
// client, with the steps it waits for. Provisioning the documentation roots is
// C41-D's, in a Docs phase that template version adds.

export type StepKind = 'agent' | 'person' | 'client';

export interface TemplateStep {
  readonly key: string;
  readonly phase: string;
  readonly kind: StepKind;
  readonly title: string;
  readonly dependsOn: readonly string[];
}

export interface OnboardingTemplate {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly steps: readonly TemplateStep[];
}

const STANDARD: OnboardingTemplate = {
  key: 'standard',
  version: 1,
  title: 'New client onboarding',
  steps: [
    {
      key: 'welcome-email',
      phase: 'Kick-off',
      kind: 'agent',
      title: 'Draft the welcome email for a person to send',
      dependsOn: [],
    },
    {
      key: 'kickoff-call',
      phase: 'Kick-off',
      kind: 'person',
      title: 'Hold the kick-off call',
      dependsOn: ['welcome-email'],
    },
    {
      key: 'access-grant',
      phase: 'Access',
      kind: 'client',
      title: 'Client grants access to their accounts',
      dependsOn: ['kickoff-call'],
    },
    {
      key: 'access-check',
      phase: 'Access',
      kind: 'agent',
      title: 'Check each account the client granted can be reached',
      dependsOn: ['access-grant'],
    },
    {
      // C35-X, LF-2: the live view works in review only when the site allows it.
      key: 'site-setup',
      phase: 'Site',
      kind: 'person',
      title:
        'For a site the agency builds or hosts: send frame-ancestors for the product origin and load the review embed script',
      dependsOn: ['kickoff-call'],
    },
  ],
};

/** Every template by key, each at its current version. */
export const ONBOARDING_TEMPLATES: Readonly<Record<string, OnboardingTemplate>> = {
  standard: STANDARD,
};

/** A step's task title: its phase first, so the board reads in phases. */
export function stepTaskTitle(step: TemplateStep): string {
  return `${step.phase}: ${step.title}`;
}
