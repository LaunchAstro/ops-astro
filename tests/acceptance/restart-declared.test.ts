// SPDX-License-Identifier: AGPL-3.0-only
//
// The restart proof's container is declared, never assumed, and never someone
// else's. These cases need no database: they are the refusals that stand
// between a restart and the wrong server, and they run on every invocation.

import { describe, expect, it } from 'vitest';
import { refusalFor } from './restart-harness.ts';

const URL_54398 = 'postgres://postgres:x@127.0.0.1:54398/ops_astro_local';

const never = (): string => {
  throw new Error('a denied name was inspected');
};

describe('the declared restart container', () => {
  it.each(['ops-astro-local-pg', 'ops-astro-datafix-pg', 'supabase_db_hub', 'supabase_auth_x'])(
    'refuses %s before asking the daemon anything',
    (name) => {
      expect(refusalFor(name, URL_54398, never)).toMatch(/deny list/u);
    },
  );

  it('refuses when no container is declared', () => {
    expect(refusalFor(undefined, URL_54398, never)).toMatch(/L5_RESTART_CONTAINER_NAME/u);
  });

  it('refuses a container that is not the server behind the URL', () => {
    expect(refusalFor('ops-astro-l5-pg', URL_54398, () => '54390')).toMatch(/54390.*54398/u);
  });

  it('refuses a container the daemon cannot place', () => {
    expect(refusalFor('ops-astro-l5-pg', URL_54398, () => undefined)).toMatch(/no published/u);
  });

  it('accepts the container whose published port is the URL port', () => {
    expect(refusalFor('ops-astro-l5-pg', URL_54398, () => '54398')).toBeUndefined();
  });
});
