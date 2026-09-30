// SPDX-License-Identifier: AGPL-3.0-only
//
// What a run's version staged and shipped (DA-03 to DA-06), read from the
// stored evidence as it is, and the one guard on the links drawn from it.

import type { RunVersion } from './run-projection.ts';

/** The four staged output kinds (DA-05), read from the stored evidence as it is. */
export type Staged =
  | { readonly kind: 'diff'; readonly where: string; readonly was: string; readonly will: string }
  | {
      readonly kind: 'pr';
      readonly repo: string;
      readonly number: number;
      readonly title: string;
      readonly files: number;
      readonly adds: number;
      readonly dels: number;
      readonly checks: string;
      readonly href: string;
    }
  | {
      readonly kind: 'ad';
      readonly account: string;
      readonly groups: readonly {
        readonly name: string;
        readonly paused: boolean;
        readonly band: string;
      }[];
      readonly spend: string;
    }
  | {
      readonly kind: 'preview';
      readonly url: string;
      readonly built: string;
      readonly note: string;
    };

export interface Shipped {
  readonly at: string;
  readonly artefact: string;
  readonly snapshot: string;
  readonly rolledBackAt: string | null;
}

/**
 * A link the pane may draw from stored evidence, or null. The evidence is the
 * agent's own writing, so a `javascript:` or `data:` address in it would run
 * in the reader's session on a click. Only an absolute http or https address
 * parsed by the URL parser is a link; anything else is drawn as text.
 */
export function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** The ad groups an ad change names, each read as it is; a row that is not one is left out. */
function adGroups(value: unknown): Extract<Staged, { readonly kind: 'ad' }>['groups'] {
  return (Array.isArray(value) ? value : []).flatMap((group: unknown) => {
    const row = record(group);
    return row === null
      ? []
      : [{ name: text(row['name']), paused: row['paused'] === true, band: text(row['band']) }];
  });
}

/**
 * What the version staged, if its evidence says so in one of the four kinds.
 * Anything else is not guessed at: the pane says nothing was staged.
 */
export function stagedOf(version: RunVersion): Staged | null {
  const staged = record(record(version.evidence?.body)?.['staged']);
  if (staged === null) return null;
  switch (staged['kind']) {
    case 'diff':
      return {
        kind: 'diff',
        where: text(staged['where']),
        was: text(staged['was']),
        will: text(staged['will']),
      };
    case 'pr':
      return {
        kind: 'pr',
        repo: text(staged['repo']),
        number: count(staged['number']),
        title: text(staged['title']),
        files: count(staged['files']),
        adds: count(staged['adds']),
        dels: count(staged['dels']),
        checks: text(staged['checks']),
        href: text(staged['href']),
      };
    case 'ad':
      return {
        kind: 'ad',
        account: text(staged['account']),
        groups: adGroups(staged['groups']),
        spend: text(staged['spend']),
      };
    case 'preview':
      return {
        kind: 'preview',
        url: text(staged['url']),
        built: text(staged['built']),
        note: text(staged['note']),
      };
    default:
      return null;
  }
}

/** The shipped record and its snapshot, if the evidence carries one (DA-06). */
export function shippedOf(version: RunVersion): Shipped | null {
  const shipped = record(record(version.evidence?.body)?.['shipped']);
  if (shipped === null) return null;
  return {
    at: text(shipped['at']),
    artefact: text(shipped['artefact']),
    snapshot: text(shipped['snapshot']),
    rolledBackAt: typeof shipped['rolledBackAt'] === 'string' ? shipped['rolledBackAt'] : null,
  };
}
