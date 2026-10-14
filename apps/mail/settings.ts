// SPDX-License-Identifier: AGPL-3.0-only
//
// The M5 mail unit's own settings (`main.ts`), read before any mail setting:
// off starts nothing; on needs the unit's own database login, the lookup
// login and the deployment's business keys, and refuses any login or key
// held elsewhere. A problem names its setting, never a value.

import { HELD_ELSEWHERE } from '../api/held-elsewhere.ts';
import { parseRecoveryScope } from '../api/recovery-entry.ts';

export type Environment = Readonly<Record<string, string | undefined>>;

export type MailUnitSettings =
  | { readonly ok: true; readonly kind: 'off' }
  | {
      readonly ok: true;
      readonly kind: 'on';
      readonly databaseUrl: string;
      readonly lookupUrl: string;
      readonly keys: readonly string[];
    }
  | { readonly ok: false; readonly problem: string };

/** The unit's own settings, before any mail setting is read. */
export function mailUnitSettings(environment: Environment): MailUnitSettings {
  const toggle = environment['MAIL_DELIVERY'] ?? '';
  if (toggle === '' || toggle === 'off') return { ok: true, kind: 'off' };
  const held = HELD_ELSEWHERE.filter((name) => (environment[name] ?? '') !== '');
  if (held.length > 0) {
    return {
      ok: false,
      problem: `${held.join(', ')} set: the mail unit never holds a login or key held elsewhere`,
    };
  }
  const value = (name: string): string => environment[name] ?? '';
  const missing = ['DATABASE_MAIL_URL', 'DATABASE_LOOKUP_URL'].filter((name) => value(name) === '');
  if (missing.length > 0) return { ok: false, problem: `mail unit not set: ${missing.join(', ')}` };
  const scope = parseRecoveryScope(environment['RECOVERY_BUSINESS_KEYS']);
  if (!scope.ok) return { ok: false, problem: scope.problem };
  return {
    ok: true,
    kind: 'on',
    databaseUrl: value('DATABASE_MAIL_URL'),
    lookupUrl: value('DATABASE_LOOKUP_URL'),
    keys: scope.keys,
  };
}
