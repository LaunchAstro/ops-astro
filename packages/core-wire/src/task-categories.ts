// SPDX-License-Identifier: AGPL-3.0-only
//
// The task category list (CS-4.16, DP-23; the nine presets of the Projects
// board's category chips, P-13 and M-04): a task's work label. A category is
// a label and nothing more (R76): it never changes what an agent may touch,
// so no grant, delegation or scope reads it.
//
// A task stores the category's id (`task.set_category`, which refuses any
// value that is not one of these ids or null); the dock panel's Category
// select and the board's category chips read the label here. A stored value
// outside the list is shown as it is stored, never renamed and never dropped.
// Each id is its label's words, lower-case and hyphenated, the key the board's
// category facet already uses.

export interface TaskCategory {
  readonly id: string;
  readonly label: string;
}

const ALL: readonly TaskCategory[] = [
  { id: 'admin', label: 'Admin' },
  { id: 'branding', label: 'Branding' },
  { id: 'content', label: 'Content' },
  { id: 'dev-integrations', label: 'Dev & Integrations' },
  { id: 'paid-ads', label: 'Paid Ads' },
  { id: 'reporting', label: 'Reporting' },
  { id: 'seo', label: 'SEO' },
  { id: 'videography', label: 'Videography' },
  { id: 'website-edits', label: 'Website Edits' },
];

export const TASK_CATEGORIES = {
  /** The menu in reading order, as the register lists the nine. */
  list: (): readonly TaskCategory[] => ALL,
  /** Whether a value is one of the nine ids: the one test the command applies. */
  has: (value: unknown): value is string => ALL.some((category) => category.id === value),
  /** A stored category's label; a value outside the list as it is stored. */
  labelOf: (stored: string): string =>
    ALL.find((category) => category.id === stored)?.label ?? stored,
};
