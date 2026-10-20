// SPDX-License-Identifier: AGPL-3.0-only
//
// What the demo data makes (#2211): three made-up clients, their tasks in each
// state, comments, plans for review and side-chat threads. Every name starts
// `Demo `, every address is reserved, and no number is a phone number;
// `demo-data.ts` checks all of it before a run and at every send.

export const TAG = 'Demo';

export type End =
  | 'new'
  | 'planned'
  | 'waiting_on_review'
  | 'accepted'
  | 'in_progress'
  | 'waiting_on_client'
  | 'on_hold'
  | 'done';

export interface DemoTask {
  readonly title: string;
  readonly client: string | null;
  readonly end: End;
  readonly description: string;
  readonly brief?: string;
  readonly comments?: readonly string[];
  /** The plan played back for review: proposed, and approved when `end` is accepted. */
  readonly plan?: { readonly purpose: string; readonly steps: readonly string[] };
}

const HARBOUR = 'Demo Harbour Physio';
const RIDGE = 'Demo Ridge Coffee Co';
const BAYSIDE = 'Demo Bayside Plumbing';
export const CLIENTS: readonly string[] = [HARBOUR, RIDGE, BAYSIDE];

const site = (slug: string, contact: string): string =>
  `Site: https://${slug}.example.com. Contact: ${contact} <${contact.split(' ')[0]?.toLowerCase()}@${slug}.example.com>.`;

export const TASKS: readonly DemoTask[] = [
  {
    title: 'Demo Refresh the home page hero',
    client: HARBOUR,
    end: 'in_progress',
    description: `New hero photo and a shorter headline. ${site('harbour-physio', 'Sam Lee')}`,
    brief: 'Keep the booking button above the fold.',
    comments: ['Photo shortlist is in the brand folder.', 'Headline draft two reads better.'],
  },
  {
    title: 'Demo Write the April newsletter',
    client: HARBOUR,
    end: 'waiting_on_review',
    description: 'Three stories: the new hydrotherapy class, a stretching tip, the Easter hours.',
    comments: ['Plan is ready for your review.'],
    plan: {
      purpose: 'demo_newsletter_draft',
      steps: ['Draft the three stories', 'Pick one photo each', 'Send the draft back for review'],
    },
  },
  {
    title: 'Demo Set up the booking reminder copy',
    client: HARBOUR,
    end: 'done',
    description: 'Reminder text for the day before an appointment.',
    comments: ['Signed off by the clinic.'],
  },
  {
    title: "Demo Add the new physio's profile",
    client: HARBOUR,
    end: 'new',
    description: 'Bio, photo and specialties for the team page.',
  },
  {
    title: 'Demo Plan the winter menu launch posts',
    client: RIDGE,
    end: 'planned',
    description: `Four posts over two weeks. ${site('ridge-coffee', 'Alex Ng')}`,
    brief: 'Warm tone, one post per new drink, no prices.',
  },
  {
    title: 'Demo Draft three Instagram captions',
    client: RIDGE,
    end: 'accepted',
    description: 'Captions for the barista, the beans and the new cups.',
    plan: {
      purpose: 'demo_caption_drafts',
      steps: ['Write three captions', 'Suggest two hashtags each', 'Hand back for approval'],
    },
  },
  {
    title: 'Demo Fix the opening hours on the contact page',
    client: RIDGE,
    end: 'done',
    description: 'Saturday now opens at seven.',
    comments: ['Live and checked on a phone.'],
  },
  {
    title: 'Demo Collect photos from the cafe',
    client: RIDGE,
    end: 'waiting_on_client',
    description: 'Waiting on the owner to send the shop photos.',
    comments: ['Asked for them on Monday.'],
  },
  {
    title: 'Demo Audit the Google Business profile',
    client: BAYSIDE,
    end: 'waiting_on_review',
    description: `Categories, service areas and photos. ${site('bayside-plumbing', 'Jo Park')}`,
    plan: {
      purpose: 'demo_profile_audit',
      steps: ['List what is missing', 'Suggest three fixes', 'Report back for review'],
    },
  },
  {
    title: 'Demo Rewrite the quote page wording',
    client: BAYSIDE,
    end: 'in_progress',
    description: 'Plainer words and one clear call to action.',
    comments: ['First pass done, checking the tone.'],
  },
  {
    title: 'Demo Emergency call-out landing page',
    client: BAYSIDE,
    end: 'new',
    description: 'A page for after-hours searches.',
  },
  {
    title: 'Demo Holiday hours banner',
    client: BAYSIDE,
    end: 'on_hold',
    description: 'Paused until the holiday roster is set.',
  },
  {
    title: 'Demo Monthly reporting template',
    client: null,
    end: 'planned',
    description: 'One page per client: visits, enquiries, what changed.',
    brief: 'Reuse the brand colours; plain tables.',
  },
  {
    title: 'Demo Tidy the shared brand folder',
    client: null,
    end: 'done',
    description: 'Old logos moved to an archive folder.',
  },
];

/** Side-chat threads: each on a task with a client, so its message reaches no model. */
export const THREADS: readonly {
  readonly title: string;
  readonly task: string;
  readonly body: string;
}[] = [
  {
    title: 'Demo Hero photo options',
    task: 'Demo Refresh the home page hero',
    body: 'Which of the two hero photos reads better on a phone?',
  },
  {
    title: 'Demo Winter posts timing',
    task: 'Demo Plan the winter menu launch posts',
    body: 'Should the first winter post go out before or after the menu changes?',
  },
  {
    title: 'Demo Quote page tone',
    task: 'Demo Rewrite the quote page wording',
    body: 'Is "no call-out fee before 5pm" clear enough for the quote page?',
  },
];

export const START_STATE: Partial<Record<End, string>> = {
  waiting_on_client: 'waiting_on_client',
  on_hold: 'on_hold',
};
