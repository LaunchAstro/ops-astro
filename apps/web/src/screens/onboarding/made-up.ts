// SPDX-License-Identifier: AGPL-3.0-only
//
// A made-up onboarding for C41-A's look, in the shape its rows have
// (`onboardings` and `onboarding_steps`, migration 0257: a phase, a kind, the
// steps it depends on, a state, and the result written onto its task). There
// is no onboarding read yet, so the page draws this inside the kit's mock
// label; a read replaces it and the label goes with it.

export type StepKind = 'agent' | 'person' | 'client';
export type StepState = 'blocked' | 'ready' | 'done' | 'stopped';

export interface OnboardingStepView {
  readonly key: string;
  readonly title: string;
  readonly phase: string;
  readonly kind: StepKind;
  readonly dependsOn: readonly string[];
  readonly state: StepState;
  /** What the step wrote onto its task, once it has. */
  readonly result: string | null;
  /** Whose move it is while it waits at a gate. */
  readonly owner: string | null;
}

export interface OnboardingView {
  readonly client: string;
  readonly template: string;
  readonly state: 'running' | 'stopped' | 'done';
  readonly steps: readonly OnboardingStepView[];
}

const step = (
  key: string,
  title: string,
  phase: string,
  kind: StepKind,
  more: Partial<OnboardingStepView> = {},
): OnboardingStepView => ({
  key,
  title,
  phase,
  kind,
  dependsOn: [],
  state: 'blocked',
  result: null,
  owner: null,
  ...more,
});

export const MADE_UP_ONBOARDING: OnboardingView = {
  client: 'Harbour Physio',
  template: 'client-onboarding, version 1',
  state: 'running',
  steps: [
    step('kick-off-brief', 'Draft the kick-off brief', 'Kick-off', 'agent', {
      state: 'done',
      result: 'Brief drafted from the sales notes: three goals, two open questions.',
    }),
    step('kick-off-email', 'Send the welcome email', 'Kick-off', 'person', {
      dependsOn: ['kick-off-brief'],
      state: 'ready',
      owner: 'Account lead',
    }),
    step('access-analytics', 'Grant analytics access', 'Access', 'client', {
      dependsOn: ['kick-off-email'],
    }),
    step('access-check', 'Check the granted access', 'Access', 'agent', {
      dependsOn: ['access-analytics'],
    }),
    step('site-embed', 'Allow the review embed on the site', 'Site setup', 'person', {
      dependsOn: ['access-check'],
    }),
    step('site-baseline', 'Record the site baseline', 'Site setup', 'agent', {
      dependsOn: ['site-embed'],
    }),
  ],
};
