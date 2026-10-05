// SPDX-License-Identifier: AGPL-3.0-only
//
// Onboarding's way into the records package (C41-A): the templates, the
// onboarding and its steps, and the owner-rule moves. The package's index
// re-exports this list whole.

export { ONBOARDING_TEMPLATES, stepTaskTitle, type OnboardingTemplate } from './template.ts';
export * from './onboardings.ts';
export { closeStepMove, parkRestoredSteps, raiseStepMoves, reparkStepMove } from './moves.ts';
