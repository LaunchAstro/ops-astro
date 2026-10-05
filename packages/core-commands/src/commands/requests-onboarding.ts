// SPDX-License-Identifier: AGPL-3.0-only
//
// New client onboarding's requests (C41-A); type, template and outcome are checked by value in the command.

export type OnboardingRequest<Envelope> =
  | ({
      readonly command: 'record.create';
      readonly type?: unknown;
      readonly fields: Readonly<Record<string, unknown>>;
    } & Envelope)
  | ({
      readonly command: 'onboarding.start';
      readonly clientId: string;
      readonly templateKey?: unknown;
    } & Envelope)
  | ({
      readonly command: 'onboarding.step_result';
      readonly recordId: string;
      readonly outcome?: unknown;
      readonly result?: unknown;
    } & Envelope);
