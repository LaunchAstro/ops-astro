// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from 'playwright';
type Surface = [string, () => Promise<void>];
interface SurfaceProps {
  readonly page: Page;
  readonly app: string | URL;
  readonly openDrawer: (variant?: 'normal' | 'empty' | 'assignable') => Promise<void>;
  readonly reset: () => void;
}
async function board(props: SurfaceProps) {
  props.reset();
  await props.page.goto(new URL('/projects/', props.app).href);
}
async function dock(props: SurfaceProps, id: string) {
  await board(props);
  await props.page.locator(`.dock__tab[data-panel=${id}]`).click();
}
async function taskPage(props: SurfaceProps, agent = false) {
  await props.openDrawer();
  await props.page.locator('[data-act=door]').last().click();
  await props.page.locator('#perspective-tab-team').waitFor();
  if (agent) await props.page.locator('#perspective-tab-agent').click();
}
async function taskEditor(props: SurfaceProps) {
  await taskPage(props);
  await props.page.getByLabel('Edit task details', { exact: true }).click();
}
async function draft(props: SurfaceProps) {
  await board(props);
  await props.page.locator('[data-projects-new-task]').first().click();
}
async function todoSearch(props: SurfaceProps) {
  await dock(props, 'todos');
  await props.page.getByLabel('Choose project scope', { exact: true }).click();
}
/** Fresh preparations for the page, drawer, dock and every option menu. */
export function taskControlSurfaces(props: SurfaceProps): Surface[] {
  return [
    ['board', () => board(props)],
    ['team', () => props.openDrawer()],
    ['page-team', () => taskPage(props)],
    ['page-team-controls', () => taskEditor(props)],
    [
      'agent',
      async () => {
        await props.openDrawer();
        await props.page
          .getByRole('tab', { name: /^Agent/u })
          .last()
          .click();
      },
    ],
    ['page-agent', () => taskPage(props, true)],
    ['draft', () => draft(props)],
    ...['notifs', 'ai', 'clients', 'todos'].map((id): Surface => [id, () => dock(props, id)]),
    ...teamMenus(props),
    ['todos-search', () => todoSearch(props)],
    ...['owner', 'estimate', 'board', 'category', 'stage', 'priority'].map((name): Surface => [
      `draft-menu-${name}`,
      async () => {
        await draft(props);
        await props.page.locator(`#panel-draft-${name}-control`).click();
      },
    ]),
    [
      'todos-menu-family',
      async () => {
        await todoSearch(props);
        await props.page.locator('#todos-client-control').click();
        await props.page.locator('#todos-client-control-menu [role=option]').nth(1).click();
        await props.page.locator('#todos-family-control').click();
      },
    ],
    ...['person', 'client'].map((name): Surface => [
      `todos-menu-${name}`,
      async () => {
        await todoSearch(props);
        await props.page.locator(`#todos-${name}-control`).click();
      },
    ]),
  ];
}
function teamMenus(props: SurfaceProps): Surface[] {
  return [
    ...['assignee', 'estimate', 'board', 'category', 'stage', 'status'].map((name): Surface => [
      `team-menu-${name}`,
      async () => {
        await props.openDrawer();
        await props.page.locator(`#panel-field-${name}-control`).click();
      },
    ]),
    [
      'team-menu-tags',
      async () => {
        await props.openDrawer();
        await props.page.locator('#panel-tag-input').focus();
      },
    ],
    [
      'team-menu-client',
      async () => {
        await props.openDrawer('empty');
        await props.page.locator('#panel-field-client-control').click();
      },
    ],
    [
      'team-menu-ai',
      async () => {
        await props.openDrawer('assignable');
        await props.page.locator('#panel-assign-ai-control').click();
      },
    ],
    [
      'team-menu-mention',
      async () => {
        await props.openDrawer();
        await props.page.locator('#panel-comment-body').fill('@');
      },
    ],
  ];
}
