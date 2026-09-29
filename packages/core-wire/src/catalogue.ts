// SPDX-License-Identifier: AGPL-3.0-only
//
// THE COMMAND CATALOGUE (API-1, CS-15.18): each command's UI entry points, API
// endpoints and CLI verb, generated (`scripts/command-parity.mjs`), never kept
// by hand, and the parity check that holds every surface to the owning command.
// It replaces capability-map discovery, not ported (issue 55). Reads no record.

import {
  COMMAND_SURFACE,
  PREFIX,
  pathOf,
  type CommandDeclaration,
  type CommandName,
} from './surface.ts';

/** A place in the app that calls a command. */
export interface UiUse {
  readonly command: string;
  readonly route: string;
  readonly file: string; // relative to apps/web/src
}

/** What a surface asks before it runs a command. The same on every surface, or parity fails. */
export interface Profile {
  /** Every key checked inside the command, `collection:action`; two parts for a two-part authority. */
  readonly authority: readonly string[];
  /** Which record the grant is asked of; a wider scope reads rows the narrower refuses. */
  readonly authorisedOn: CommandDeclaration['authorisedOn'];
  /** Refuses every agent credential, even a delegation holding the key, on every path. */
  readonly personOnly: boolean;
  /** A hold every path keeps before it writes, as the owning command states it. */
  readonly rule: string;
}

export interface CatalogueRow extends Profile {
  readonly command: CommandName;
  readonly kind: 'read' | 'write';
  readonly permissionKey: string;
  readonly api: { readonly person: string; readonly agent: string | null };
  readonly cli: string;
  /** `route (file)`, one per place the app calls it. Empty: no UI entry point yet. */
  readonly ui: readonly string[];
  /** Filled beside the key by S0-5 (U18, wave 6): whether it admits a new outside person. */
  readonly dataEffects: null;
}

/** A UI action with no command, and why it needs none (CS-15.18). */
export interface Exempt {
  readonly action: string;
  readonly reason: string;
}

export const VIEW_ONLY_EXEMPT: readonly Exempt[] = [
  { action: 'navigate', reason: 'changes the address; the page reads through its own command' },
  { action: 'focus', reason: 'moves keyboard focus; nothing is read or written' },
  { action: 'scroll', reason: 'moves the view; nothing is read or written' },
  { action: 'open or close a dock', reason: 'view state; its contents read through a command' },
  { action: 'switch a tab', reason: 'view state; the tab reads through its own command' },
];

/** Keys an agent never holds (contract 2.3 to 2.6). */
const PERSON_ACTIONS: ReadonlySet<string> = new Set(['decide', 'share', 'manage']);

const actionOf = (key: string): string => key.slice(key.indexOf(':') + 1);

/** The profile the owning command declares, which every surface must ask. */
export function profileOf(declaration: CommandDeclaration): Profile {
  const key = `${declaration.collection}:${declaration.action}`;
  const authority = declaration.authority ?? [key];
  return {
    authority,
    authorisedOn: declaration.authorisedOn,
    personOnly:
      declaration.agent === 'never' || authority.some((one) => PERSON_ACTIONS.has(actionOf(one))),
    rule: declaration.rule ?? '',
  };
}

export function buildCatalogue(
  uses: readonly UiUse[],
  declarations: readonly CommandDeclaration[] = COMMAND_SURFACE,
): CatalogueRow[] {
  return declarations.map((declaration) => {
    const profile = profileOf(declaration);
    const path = pathOf(declaration.name);
    const ui = uses
      .filter((use) => use.command === declaration.name)
      .map((use) => `${use.route} (${use.file})`);
    return {
      command: declaration.name,
      kind: declaration.kind,
      permissionKey: `${declaration.collection}:${declaration.action}`,
      ...profile,
      api: {
        person: `${PREFIX.person}:businessKey${path}`,
        agent: profile.personOnly ? null : `${PREFIX.agent}:businessKey${path}`,
      },
      cli: declaration.name,
      ui: [...new Set(ui)].toSorted(),
      dataEffects: null,
    };
  });
}

export interface Surfaces {
  readonly api: ReadonlyMap<string, Profile>;
  readonly cli: ReadonlyMap<string, Profile>;
  readonly web: ReadonlyMap<string, Profile>;
  readonly ui: readonly UiUse[];
  readonly exempt: readonly Exempt[];
}

function compare(surface: string, command: string, owned: Profile, asked: Profile): string[] {
  const failures: string[] = [];
  for (const key of owned.authority) {
    if (!asked.authority.includes(key)) {
      failures.push(`${surface} ${command} skips the grant check ${key} the app makes`);
    }
  }
  if (asked.authorisedOn !== owned.authorisedOn) {
    failures.push(
      `${surface} ${command} asks at ${asked.authorisedOn} scope where the app asks at ${owned.authorisedOn}`,
    );
  }
  if (owned.personOnly && !asked.personOnly) {
    failures.push(`${surface} ${command} drops the person-only marker and admits an agent`);
  }
  if (asked.rule !== owned.rule) {
    failures.push(`${surface} ${command} passes the hold the app keeps: ${owned.rule || 'none'}`);
  }
  return failures;
}

/** Every way the catalogue and surfaces disagree, as plain lines; empty is parity. */
export function checkParity(
  rows: readonly CatalogueRow[],
  surfaces: Surfaces,
  declarations: readonly CommandDeclaration[] = COMMAND_SURFACE,
): string[] {
  const failures: string[] = [];
  const owned = new Map(declarations.map((one) => [one.name as string, profileOf(one)]));
  const reaches = Object.entries({ API: surfaces.api, CLI: surfaces.cli, app: surfaces.web });
  for (const [name, profile] of owned) {
    const row = rows.find((one) => one.command === name);
    if (row === undefined) failures.push(`the catalogue has no row for ${name}`);
    else failures.push(...compare('catalogue row', name, profile, row));
    for (const [surface, reach] of reaches) {
      const asked = reach.get(name);
      if (asked === undefined) failures.push(`${name} has no ${surface} equivalent`);
      else failures.push(...compare(surface, name, profile, asked));
    }
  }
  for (const [surface, reach] of reaches) {
    for (const name of reach.keys()) {
      if (!owned.has(name)) failures.push(`${surface} reaches ${name}, which no command owns`);
    }
  }
  for (const row of rows) {
    if (!owned.has(row.command)) failures.push(`the catalogue row ${row.command} has no command`);
    const heldByAgent = row.authority.filter((key) => PERSON_ACTIONS.has(actionOf(key)));
    if (!row.personOnly && heldByAgent.length > 0) {
      failures.push(`${row.command} is agent-eligible and holds ${heldByAgent.join(', ')}`);
    }
  }
  for (const use of surfaces.ui) {
    for (const [what, reach] of [
      ['CLI verb', surfaces.cli],
      ['API endpoint', surfaces.api],
    ] as const) {
      const at = `${use.command} at ${use.route} (${use.file})`;
      if (!reach.has(use.command)) failures.push(`the app action ${at} has no ${what}`);
    }
  }
  for (const exempt of surfaces.exempt) {
    if (owned.has(exempt.action) || rows.some((row) => row.command === exempt.action)) {
      failures.push(`${exempt.action} reads or writes a record and cannot be exempt`);
    }
  }
  return failures;
}

export interface HeldGrant {
  readonly key: string;
  readonly scope: { readonly kind: 'business' | 'party' | 'record'; readonly id: string | null };
}

/** Which commands `principal` may call, and where (issue 55). A business-scoped command needs business-wide keys. */
export function reachableBy(
  rows: readonly CatalogueRow[],
  principal: { readonly kind: 'person' | 'agent'; readonly grants: readonly HeldGrant[] },
): { readonly command: CommandName; readonly surfaces: readonly string[] }[] {
  const holds = (key: string, wide: boolean) =>
    principal.grants.some((one) => one.key === key && (!wide || one.scope.kind === 'business'));
  return rows
    .filter((row) => principal.kind === 'person' || !row.personOnly)
    .filter((row) => row.authority.every((key) => holds(key, row.authorisedOn === 'business')))
    .map((row) => ({
      command: row.command,
      surfaces: [...(row.ui.length > 0 ? ['app'] : []), 'API', 'CLI'],
    }));
}

/** The owner's parity report: every button that changes something, with its CLI command. */
export function renderReport(rows: readonly CatalogueRow[], failures: readonly string[]): string {
  const buttons = rows.filter((row) => row.kind === 'write' && row.ui.length > 0);
  const lines = [
    '# Command parity report',
    '',
    '| App action | Where | CLI command | API endpoint | Key |',
    '| --- | --- | --- | --- | --- |',
    ...buttons.map(
      (row) =>
        `| ${row.command} | ${row.ui.join('; ')} | \`pnpm cli ${row.cli}\` | ${row.api.person} | ${row.permissionKey} |`,
    ),
    '',
    failures.length === 0
      ? `${String(buttons.length)} app actions change something; each has its CLI command. None is missing.`
      : `Missing or unequal:\n${failures.map((line) => `- ${line}`).join('\n')}`,
    '',
    'Exempt, view only:',
    ...VIEW_ONLY_EXEMPT.map((one) => `- ${one.action}: ${one.reason}`),
  ];
  return `${lines.join('\n')}\n`;
}
