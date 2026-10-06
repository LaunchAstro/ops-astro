// SPDX-License-Identifier: AGPL-3.0-only
//
// The new-task draft's guesses from the page it was filed from (MP-4-13,
// DN-02; DOCK T-17): the category, owner, estimate, due day and client, and
// the one sentence that admits they were guessed.
//
// **Every guess is labelled as one.** The draft names what it guessed from
// (the door's subject, its board, the move being urgent), or says nothing was
// there to guess from and which field fell back to its default.
//
// **Never a fixed client.** The client is the one the door or the page names,
// or none. The owner is the person the door names, or nobody: no
// category-to-person table exists yet, so the draft guesses no one rather
// than a made-up person.
//
// **The category hangs off the door, then its board.** A door's own category
// wins; else its board's channel maps to one; else Admin, said as a fallback.
// The estimate is that category's usual size; the due day is a week out, or
// three days when the door flags the move urgent, on the business's day.

import { TASK_CATEGORIES } from '../../../../../packages/core-wire/src/index.ts';
import { addDays, todayOn } from './due-dates.ts';

/** What a task-filing door, or the page behind the dock's New task, says about the work. */
export interface PageContext {
  /** The page's name, for "filed from". */
  readonly from: string;
  /** The thing the door is about, for the name's placeholder and the sentence. */
  readonly subject?: string;
  readonly channel?: string;
  readonly channelLabel?: string;
  readonly category?: string;
  readonly urgent?: boolean;
  readonly clientId?: string | null;
  readonly owner?: { readonly id: string; readonly name: string } | null;
}

/** The draft's fields the page fills in, and the sentence that admits it. */
export interface Prefill {
  readonly category: string;
  readonly estimate: number;
  readonly due: string;
  readonly clientId: string | null;
  readonly owner: { readonly id: string; readonly name: string } | null;
  readonly why: string;
}

/** A board's channel to the category its work usually is. */
const BY_CHANNEL: Readonly<Record<string, string>> = {
  site: 'website-edits',
  clarity: 'website-edits',
  forms: 'website-edits',
  testing: 'website-edits',
  perf: 'dev-integrations',
  calls: 'dev-integrations',
  search: 'seo',
  intent: 'seo',
  local: 'seo',
  ads: 'paid-ads',
  meta: 'paid-ads',
  email: 'content',
  funnel: 'reporting',
  revenue: 'reporting',
};

/** A category to the minutes a job of its shape usually takes. */
const ESTIMATE: Readonly<Record<string, number>> = {
  'website-edits': 120,
  'dev-integrations': 120,
  seo: 240,
  content: 120,
  'paid-ads': 60,
  reporting: 60,
  branding: 240,
  videography: 480,
  admin: 30,
};

const FALLBACK = 'admin';
const DUE_DAYS = 7;
const DUE_DAYS_URGENT = 3;

export function prefillOf(page: PageContext, now: Date): Prefill {
  const own = TASK_CATEGORIES.has(page.category) ? page.category : null;
  const routed = page.channel === undefined ? undefined : BY_CHANNEL[page.channel];
  const category = own ?? routed ?? FALLBACK;
  const urgent = page.urgent === true;
  const days = urgent ? DUE_DAYS_URGENT : DUE_DAYS;
  const from = [
    page.subject === undefined || page.subject === '' ? null : `“${page.subject}”`,
    routed === undefined || own !== null ? null : `the ${page.channelLabel ?? page.from} board`,
    urgent ? 'the move being flagged urgent' : null,
  ].filter((part) => part !== null);
  const owner = page.owner ?? null;
  const why = [
    from.length > 0
      ? `Guessed from ${from.join(', ')}: due in`
      : 'Nothing here to guess from: due in',
    ` ${String(days)} days`,
    urgent ? ', pulled in because this move is flagged urgent' : '',
    own === null && routed === undefined ? ', and the category fell back to Admin' : '',
    owner === null ? '; no owner guessed' : `; owner ${owner.name}`,
    '.',
  ].join('');
  return {
    category,
    estimate: ESTIMATE[category] ?? 60,
    due: addDays(todayOn(now), days),
    clientId: page.clientId ?? null,
    owner,
    why,
  };
}

/** The page's name, as the mockup reads it: the main heading, else the document's title. */
export function pageName(): string {
  const heading = document.querySelector('main h1')?.textContent?.trim() ?? '';
  return heading === '' ? document.title || 'this page' : heading;
}

/** A task-filing door's context from its `data-new-task*` attributes, on the page it sits on. */
export function doorContext(door: HTMLElement): PageContext {
  const read = (name: string): string | undefined => door.dataset[name] || undefined;
  const ownerId = read('newTaskOwner');
  return {
    from: read('newTaskLabel') ?? pageName(),
    subject: read('newTask'),
    channel: read('newTaskChannel'),
    channelLabel: read('newTaskLabel'),
    category: read('newTaskCategory'),
    urgent: door.dataset['newTaskUrgent'] !== undefined,
    clientId: read('newTaskClient') ?? null,
    owner: ownerId === undefined ? null : { id: ownerId, name: read('newTaskOwnerName') ?? 'them' },
  };
}
