// SPDX-License-Identifier: AGPL-3.0-only
import type { Action } from './grants.ts';
import type { Assurance } from '../identity/verified-subject.ts';

export const STEP_UP_WINDOW_SECONDS: number = 60 * 60;
export const MONEY_STEP_UP_SETTING: string = 'money_step_up_required';

export function isMoneyKey(_collection: string, _action: Action): boolean {
  return false;
}

export function judgeStepUp(
  _standing: { readonly roleKey: string | null; readonly assurance: Assurance },
  _now: number,
): 'fresh' | 'stale' {
  return 'fresh';
}
