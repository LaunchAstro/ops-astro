// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-3-1a: the dock registry's rules (C2, C3, C6, C12).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PANELS,
  PANEL_RANK,
  dockTabs,
  isPanelId,
  type PanelRegistration,
  type PanelRegistry,
} from '../../apps/web/src/panels.ts';
import { matchRoute, pathTo } from '../../apps/web/src/routes.ts';

const settings: PanelRegistration = {
  label: 'Settings',
  ariaLabel: 'Business settings',
  route: 'agency:settings',
};
const board: PanelRegistration = {
  label: 'Projects',
  ariaLabel: 'Projects',
  route: 'agency:projects-board',
};

// Never called: each is a type error.
const strayId = (): PanelRegistry => ({
  // @ts-expect-error an id outside the declared list cannot be registered
  bell: settings,
});
const ownRank = (): PanelRegistration => ({
  ...settings,
  // @ts-expect-error a registration carries no rank of its own
  rank: 1,
});
const noBody = (): PanelRegistration => ({
  ...settings,
  // @ts-expect-error a tab onto nothing cannot be registered
  route: null,
});

const PANEL_ID = new RegExp(`['"\`](?:${PANEL_RANK.join('|')})['"\`]`, 'u');
const SECOND_ORDER = new RegExp(`${PANEL_ID.source}\\s*,\\s*${PANEL_ID.source}`, 'u');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function code(file: string): string {
  return withoutComments(readFileSync(file, 'utf8'));
}

function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
    .join('\n');
}

describe('MP-3-1 tab rank one list', () => {
  it('orders the rail by the declared list, whatever order the registrations were written in', () => {
    const forwards: PanelRegistry = { todos: board, settings };
    const backwards: PanelRegistry = { settings, todos: board };
    expect(dockTabs({}, forwards).map((tab) => tab.id)).toEqual(['todos', 'settings']);
    expect(dockTabs({}, backwards).map((tab) => tab.id)).toEqual(['todos', 'settings']);
  });

  it('follows the declared list for the registry the application ships', () => {
    const shipped = dockTabs().map((tab) => tab.id);
    expect(shipped).toEqual(PANEL_RANK.filter((id) => PANELS[id] !== undefined));
  });

  it('spots a second order however it is spelt, and not one in a comment', () => {
    const declares = (text: string): boolean => SECOND_ORDER.test(withoutComments(text));
    expect(declares("const o = ['team',\t'ai'];")).toBe(true);
    expect(declares('const o = [\n  "notes",\n  `marks`,\n];')).toBe(true);
    expect(declares("x(['clients' ,'todos'])")).toBe(true);
    expect(declares("// ['team', 'ai']\n * 'notes', 'marks'")).toBe(false);
    expect(declares("const o = ['team', 'Team label'];")).toBe(false);
  });

  it('declares the order in one place: no other source lists two panel ids in a row', () => {
    const declaring = [...sources(resolve('apps/web/src')), ...sources(resolve('packages/ui/src'))]
      .filter((file) => SECOND_ORDER.test(code(file)))
      .map((file) => relative(process.cwd(), file));
    expect(declaring).toEqual(['apps/web/src/panels.ts']);
    expect(ownRank).toBeTypeOf('function');
  });
});

describe('MP-3-1 ids fixed', () => {
  it('freezes the ids in DR-59 rank, top to bottom, with the working slice last', () => {
    expect(PANEL_RANK).toEqual([
      'ai',
      'notifs',
      'team',
      'clients',
      'todos',
      'task',
      'marks',
      'notes',
      'settings',
    ]);
    expect(Object.isFrozen(PANEL_RANK)).toBe(true);
  });

  it('takes the tab id from the registry key and the label from the registration', () => {
    const renamed: PanelRegistry = { settings: { ...settings, label: 'Business' } };
    expect(dockTabs({}, renamed)).toEqual([
      { id: 'settings', label: 'Business', route: 'agency:settings', count: null },
    ]);
  });

  it('admits only the declared ids from outside, such as a stored open set', () => {
    expect(PANEL_RANK.every((id) => isPanelId(id))).toBe(true);
    expect(['Settings', 'bell', '', 'constructor', 'toString'].some((id) => isPanelId(id))).toBe(
      false,
    );
    expect(strayId).toBeTypeOf('function');
  });
});

describe('MP-3-1 data-backed tabs', () => {
  it('draws no tab for a panel with no registration (R34)', () => {
    expect(dockTabs({ clients: 4, team: 2 }, { settings }).map((tab) => tab.id)).toEqual([
      'settings',
    ]);
  });

  it('draws no tab for a registration whose route reads no data, such as sign-in', () => {
    const signIn: PanelRegistration = { ...settings, route: 'agency:sign-in' };
    expect(dockTabs({ ai: 3 }, { ai: signIn, settings }).map((tab) => tab.id)).toEqual([
      'settings',
    ]);
  });

  it('points every shipped tab at a route the router serves', () => {
    for (const tab of dockTabs()) {
      expect(matchRoute(pathTo(tab.route))?.id).toBe(tab.route);
    }
    expect(noBody).toBeTypeOf('function');
  });
});

describe('MP-3-1 count chips derived', () => {
  const registry: PanelRegistry = { todos: board, settings };

  it('paints each count as the tab is built, uncapped', () => {
    expect(dockTabs({ todos: 120, settings: 9 }, registry)).toEqual([
      { id: 'todos', label: 'Projects', route: 'agency:projects-board', count: '120' },
      { id: 'settings', label: 'Settings', route: 'agency:settings', count: '9' },
    ]);
  });

  it('draws no chip at zero or with no count', () => {
    expect(dockTabs({ todos: 0 }, registry).map((tab) => tab.count)).toEqual([null, null]);
  });
});
