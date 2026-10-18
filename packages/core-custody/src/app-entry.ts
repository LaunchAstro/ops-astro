// SPDX-License-Identifier: AGPL-3.0-only
//
// A GitHub App entry in custody's credential list (`scheme: 'github_app'`,
// #1793): the App's RSA private key, its id, and for each party the one site
// repository it may reach with the installation that covers it. No party
// reaches two repositories and no repository belongs to two parties, in any
// spelling: GitHub reads a repository's name in any case. Custody
// never presents the key: it mints a token per call (`github-app.ts`).
// Custody's process loads this file, so it imports no connector or database code.

import { createPrivateKey } from 'node:crypto';

const REF = /^[a-z][a-z0-9_]{0,62}$/u;

/** One party's site repository, `owner/name`, and the App installation that covers it. */
export interface AppBinding {
  readonly party: string;
  readonly repository: string;
  readonly installation: number;
}

export interface GithubApp {
  readonly id: string;
  readonly bindings: readonly AppBinding[];
}

const APP_KEYS = 'account,app,destination,header,kind,ref,scheme,value';
const APP_ID = /^[1-9][0-9]{0,11}$/u;
const PARTY = /^[A-Za-z0-9_-]{1,128}$/u;
/** GitHub's own spelling of an owner and a name; never `.` or `..` as the name. */
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u;

/** Whether two `owner/name` spellings are one repository: GitHub reads names in any case. */
export const sameRepository = (one: string, other: string): boolean =>
  one.toLowerCase() === other.toLowerCase();

/** Whether a value is an RSA private key, the only kind an App signs with. */
function isRsaKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return createPrivateKey(value).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

/** Bindings each with its own party and repository, no two sharing either. */
function bindingsOf(listed: unknown): readonly AppBinding[] | undefined {
  if (!Array.isArray(listed)) return undefined;
  const bindings: AppBinding[] = [];
  for (const shape of listed as unknown[]) {
    if (typeof shape !== 'object' || shape === null) return undefined;
    const { party, repository, installation } = shape as Record<string, unknown>;
    if (
      Object.keys(shape).length !== 3 ||
      typeof party !== 'string' ||
      !PARTY.test(party) ||
      typeof repository !== 'string' ||
      !REPOSITORY.test(repository) ||
      typeof installation !== 'number' ||
      !Number.isSafeInteger(installation) ||
      installation < 1 ||
      bindings.some((one) => one.party === party || sameRepository(one.repository, repository))
    ) {
      return undefined;
    }
    bindings.push({ party, repository, installation });
  }
  return bindings;
}

/**
 * A GitHub App entry's own fields, when the entry holds exactly its declared
 * fields and each is well formed; its `ref` is the credential list's to check.
 */
export function appOf(shape: Record<string, unknown>):
  | {
      readonly account: string;
      readonly destination: string;
      readonly value: string;
      readonly app: GithubApp;
    }
  | undefined {
  const { kind, account, destination, header, value, app } = shape;
  const { id, bindings: listed } = (app ?? {}) as Record<string, unknown>;
  const bindings = bindingsOf(listed);
  if (
    Object.keys(shape).toSorted().join() !== APP_KEYS ||
    kind !== 'api_key' ||
    typeof account !== 'string' ||
    account === '' ||
    typeof destination !== 'string' ||
    !REF.test(destination) ||
    header !== 'authorization' ||
    typeof app !== 'object' ||
    app === null ||
    Object.keys(app).length !== 2 ||
    typeof id !== 'string' ||
    !APP_ID.test(id) ||
    bindings === undefined ||
    !isRsaKey(value)
  ) {
    return undefined;
  }
  return { account, destination, value, app: { id, bindings } };
}
