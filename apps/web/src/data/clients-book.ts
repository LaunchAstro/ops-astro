// SPDX-License-Identifier: AGPL-3.0-only
//
// THE CLIENT BOOK the dock's Clients panel draws (DOCK.md section 2), in the
// shape the client-records read will answer it once MP-10-1 builds client
// records. Nothing here is read from anywhere: the book below is made up, the
// panel marks it with the design system's mock mark (DS-PRIM-32) and says so,
// and the real read replaces `MADE_UP_BOOK` behind the same interface.

/** One client in the book, as the client-records read will answer it. */
export interface BookClient {
  /** The client's address slug, as `/clients/:client/` spells it. */
  readonly slug: string;
  readonly name: string;
  readonly industry: string;
  /**
   * The client's open work: to-do rows, projects not complete and chores, one
   * each by id (DOCK.md section 2, the counting rule).
   */
  readonly open: number;
  /** Client messages waiting on an answer from us. */
  readonly waiting: number;
}

/** The whole book the person may see: the count line counts this, never a second total (D-6). */
export interface ClientBook {
  readonly clients: readonly BookClient[];
}

/** Made up for the look until MP-10-1: no real client, no real count. */
export const MADE_UP_BOOK: ClientBook = {
  clients: [
    {
      slug: 'harbour-physio',
      name: 'Harbour Physio',
      industry: 'Physiotherapy',
      open: 7,
      waiting: 2,
    },
    { slug: 'kestrel-dental', name: 'Kestrel Dental', industry: 'Dental', open: 12, waiting: 3 },
    {
      slug: 'banksia-allied-health',
      name: 'Banksia Allied Health',
      industry: 'Allied health',
      open: 5,
      waiting: 0,
    },
    {
      slug: 'tidewater-chiro',
      name: 'Tidewater Chiropractic',
      industry: 'Chiropractic',
      open: 4,
      waiting: 1,
    },
    {
      slug: 'wattle-street-podiatry',
      name: 'Wattle Street Podiatry',
      industry: 'Podiatry',
      open: 3,
      waiting: 0,
    },
    {
      slug: 'ironbark-legal',
      name: 'Ironbark Legal',
      industry: 'Legal services',
      open: 9,
      waiting: 4,
    },
    {
      slug: 'saltbush-kitchen',
      name: 'Saltbush Kitchen',
      industry: 'Hospitality',
      open: 2,
      waiting: 0,
    },
    {
      slug: 'lorikeet-pilates',
      name: 'Lorikeet Pilates',
      industry: 'Fitness',
      open: 6,
      waiting: 1,
    },
  ],
};
