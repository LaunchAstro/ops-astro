// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in provider's side of a person's second factor (C59): what the
// provider is asked, what it answers, and how a failure is named. The acts
// that call it are in account-factor.ts.

import { refuseCommand, type CommandRefusal } from './refusal.ts';

/** What can go wrong at the provider, by kind only (TR-SEC4R-5). */
export type ProviderFault = 'refused' | 'malformed' | 'oversized' | 'slow' | 'unreachable';

export type ProviderAnswer<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: ProviderFault };

/** A factor the provider has just issued. The secret goes to the person once. */
export interface IssuedFactor {
  readonly factorId: string;
  readonly qrCode: string;
  readonly secret: string;
  readonly uri: string;
}

/** The session a verified code gives: now at `aal2`. */
export interface FactorSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

/** The provider's three second-factor calls, made with the person's own token. */
export interface FactorProvider {
  enrol(accessToken: string): Promise<ProviderAnswer<IssuedFactor>>;
  verify(
    accessToken: string,
    factorId: string,
    code: string,
  ): Promise<ProviderAnswer<FactorSession>>;
  remove(accessToken: string, factorId: string): Promise<ProviderAnswer<void>>;
}

const CODE_FIXES: readonly string[] = [
  'Enter the six-digit code your authenticator app shows now.',
];
const PROVIDER_FIXES: readonly string[] = [
  'The sign-in service did not answer as expected. Nothing was changed; try again shortly.',
];

/**
 * A provider's no to a code is a wrong code, recorded as the failed attempt;
 * any other fault, and a no to anything but a code, is the provider's answer
 * refused, by its kind alone.
 */
export function providerRefusal(fault: ProviderFault, asked: 'code' | 'answer'): CommandRefusal {
  return fault === 'refused' && asked === 'code'
    ? refuseCommand('SECOND_FACTOR_INVALID', [], CODE_FIXES)
    : refuseCommand('PROVIDER_ANSWER_INVALID', [fault], PROVIDER_FIXES);
}
