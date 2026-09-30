// SPDX-License-Identifier: AGPL-3.0-only
//
// State the application's frame keeps that no screen owns: the address as
// corrected, whether the browser is connected, and the signed-in person's name.

import { useEffect, useState } from 'react';
import { canonicalOf } from './legacy.ts';
import type { OperationsClient } from './operations/client.ts';
import { pathTo } from './routes.ts';
import { useStoredAppearance } from './appearance.ts';
import { grantKeyOf, type Session, type StorageLike } from './session/token.ts';

/** Portfolio Command's address (R1), where a signed-in arrival at `/` goes (R3). */
const DASHBOARD = '/dashboard/';

/**
 * The address the application draws for `path`, corrected in the address bar.
 *
 * The root address is not a screen and it is not a mistake either: it is how
 * a person arrives. There is no launcher page (R3): it leads to the
 * dashboard when there is a session and to sign-in when there is not, and
 * the address bar is corrected to say so, so a reload lands on the same
 * place a link would.
 * A legacy address is answered with its canonical one the same way, so the
 * address bar, the rail and a remembered interruption never hold a legacy one.
 */
export function useCanonicalAddress(
  path: string,
  signedIn: boolean,
  navigate: (path: string, options?: { readonly replace?: boolean }) => void,
): string {
  const here =
    canonicalOf(path) ?? (path === '/' ? (signedIn ? DASHBOARD : pathTo('agency:sign-in')) : path);
  useEffect(() => {
    if (here !== path) navigate(here, { replace: true });
  }, [here, path, navigate]);
  return here;
}

/**
 * When the browser last said the connection dropped, as a clock time, or null
 * while it is connected: the header's freshness marker (MP-1-6, CS-1.1) says
 * "Offline · showing data from" that time, since nothing on the page was read
 * after it. Live sync (C4) supplies the other states when it lands; until then
 * the marker shows only a dropped connection and claims nothing live.
 */
export function useOfflineSince(): string | null {
  const [since, setSince] = useState<string | null>(() =>
    typeof navigator === 'undefined' || navigator.onLine ? null : clockNow(),
  );
  useEffect(() => {
    const update = (): void => {
      setSince(navigator.onLine ? null : clockNow());
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return since;
}

const clockNow = (): string =>
  new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * Who is signed in, for the person menu (C23): the server's name for this
 * session's person, kept only while it is still this session's, or null. The
 * same person's stored appearance (MP-2-11) is applied here too, and dropped
 * when nobody is signed in.
 */
export function usePersonName(
  client: OperationsClient,
  session: Session | null,
  storage: StorageLike | null,
): string | null {
  useStoredAppearance(client, session === null ? null : grantKeyOf(session), storage);
  const [person, setPerson] = useState<{ readonly of: Session; readonly name: string } | null>(
    null,
  );
  useEffect(() => {
    if (session === null) return;
    let current = true;
    void client.read<unknown>('session.person', {}).then((answer) => {
      // Read as the server's answer, not as the type it should have: a body
      // without a name leaves the email standing in, and never throws.
      const name = 'value' in answer ? nameIn(answer.value) : null;
      if (current && name !== null) setPerson({ of: session, name });
      return answer;
    });
    return () => {
      current = false;
    };
  }, [client, session]);
  return person !== null && person.of === session ? person.name : null;
}

/** The name in a `session.person` answer, or null for anything else. */
function nameIn(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const person = (value as { readonly person?: unknown }).person;
  if (typeof person !== 'object' || person === null) return null;
  const name = (person as { readonly name?: unknown }).name;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/**
 * Compiled in by the build's stamp (`apps/web/vite.config.ts`); absent under a
 * bundler that did not stamp, and the rail then says the build is unstamped.
 * Read by name, never by index: an indexed read inlines every VITE_ setting
 * of the build's environment into the bundle (G3).
 */
export function buildStamp(): string | null {
  const build = import.meta.env.VITE_OPS_ASTRO_BUILD ?? '';
  return build === '' ? null : build;
}
