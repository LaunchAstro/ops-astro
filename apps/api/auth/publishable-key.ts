// SPDX-License-Identifier: AGPL-3.0-only
//
// The provider's key the page sends with a sign-in (S0-6). `GET /api/sign-in`
// hands it to anyone, so only a key made to be public is accepted: a
// publishable key, or a legacy key whose role is `anon`. A secret key, a
// `service_role` key or anything else stops the function starting, named by
// the setting and never by its value.

const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]+$/u;

function legacyRole(key: string): unknown {
  const [, payload] = key.split('.');
  try {
    return (
      JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
        role?: unknown;
      }
    ).role;
  } catch {
    return undefined;
  }
}

/** The key to hand the page, '' when unset; throws for any key not made to be public. */
export function publishableKey(value: string | undefined): string {
  const key = value ?? '';
  if (key === '' || PUBLISHABLE.test(key)) return key;
  if (key.split('.').length === 3 && legacyRole(key) === 'anon') return key;
  throw new Error(
    'SUPABASE_PUBLISHABLE_KEY is not a publishable key (sb_publishable_... or the anon key); ' +
      'the page hands it to anyone.',
  );
}
