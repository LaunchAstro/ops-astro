// SPDX-License-Identifier: AGPL-3.0-only
//
// #1988: a reply may end with a `site_change` block, the plan played back as
// the task (spec #1995). It is read only when whole and naming one of the
// pages the model was given; it reads as a create whose description is the
// plan section and whose estimate is the plan's, so the click is the create
// card's one write. The agent's draft reads the plan back from the task and
// asks the correction on the request's existing shape.

import { describe, expect, it } from 'vitest';
import {
  proposalCreate,
  readProposal,
  SITE_TEXT_LIMIT,
  sitePlanRequest,
} from '../../packages/core-wire/src/index.ts';

const PAGES = [
  { repository: 'agency-astro/site', page: 'https://agencyastro.com/about' },
  { repository: 'agency-astro/site', page: 'https://agencyastro.com/contact' },
];
const PLAN = {
  action: 'site_change',
  title: 'About page: say Townsville',
  page: 'https://agencyastro.com/about',
  before: 'Based in Brisbane',
  after: 'Based in Townsville',
  client: 'internal',
  estimate: 15,
};
const reply = (plan: Readonly<Record<string, unknown>>, words = 'Here is the plan.'): string =>
  `${words}\n\n\`\`\`task\n${JSON.stringify(plan)}\n\`\`\``;

const SECTION = [
  'Site change plan',
  'Site: agency-astro/site',
  'Page: https://agencyastro.com/about',
  'Before: Based in Brisbane',
  'After: Based in Townsville',
  'Client: internal',
  'Estimate: 15 minutes',
].join('\n');

// eslint-disable-next-line max-lines-per-function -- each case of the block contract, on one reader
describe('a site change block', () => {
  it('reads a whole block on a bound page as a create carrying the plan, its section and its estimate', () => {
    expect(readProposal(reply(PLAN), PAGES)).toStrictEqual({
      words: 'Here is the plan.',
      proposal: {
        action: 'create',
        title: 'About page: say Townsville',
        description: SECTION,
        estimate: 15,
        site: {
          repository: 'agency-astro/site',
          page: 'https://agencyastro.com/about',
          before: 'Based in Brisbane',
          after: 'Based in Townsville',
          client: 'internal',
        },
      },
    });
  });

  it('refuses a page the model was not given, and any page when it was given none', () => {
    const elsewhere = { ...PLAN, page: 'https://agencyastro.com/careers' };
    expect(readProposal(reply(elsewhere), PAGES).proposal).toBeNull();
    expect(readProposal(reply(PLAN), []).proposal).toBeNull();
    expect(readProposal(reply(PLAN)).proposal).toBeNull();
    // Refused, the reply is drawn as written.
    expect(readProposal(reply(elsewhere), PAGES).words).toBe(reply(elsewhere));
  });

  it('refuses a block missing any key, or naming one it does not take', () => {
    for (const key of ['title', 'page', 'before', 'after', 'client', 'estimate'] as const) {
      const { [key]: _gone, ...missing } = PLAN;
      expect(readProposal(reply(missing), PAGES).proposal, key).toBeNull();
    }
    for (const extra of [{ description: 'More' }, { due: '2026-10-20' }, { repository: 'x/y' }]) {
      expect(readProposal(reply({ ...PLAN, ...extra }), PAGES).proposal).toBeNull();
    }
  });

  it('refuses a before or after over the phrase bound, on two lines, empty, or unchanged', () => {
    const long = 'a'.repeat(SITE_TEXT_LIMIT + 1);
    expect(SITE_TEXT_LIMIT).toBe(200);
    expect(
      readProposal(reply({ ...PLAN, before: 'a'.repeat(200) }), PAGES).proposal,
    ).not.toBeNull();
    for (const odd of [
      { before: long },
      { after: long },
      { before: 'Based in\nBrisbane' },
      { after: 'Based in\tTownsville' },
      { before: '   ' },
      { before: 'Based  in Brisbane' },
      { before: ' Based in Brisbane' },
      { after: 'Based in <b>Townsville</b>' },
      { after: 'Based in {city}' },
      { after: 'Based in\u200BTownsville' },
      { after: 'Based in Brisbane' },
    ]) {
      expect(
        readProposal(reply({ ...PLAN, ...odd }), PAGES).proposal,
        JSON.stringify(odd),
      ).toBeNull();
    }
  });

  it('refuses a client other than internal, and an estimate that is not whole minutes', () => {
    for (const odd of [
      { client: 'Wattle Cafe' },
      { estimate: 0.5 },
      { estimate: -1 },
      { estimate: '15' },
    ]) {
      expect(readProposal(reply({ ...PLAN, ...odd }), PAGES).proposal).toBeNull();
    }
  });

  it('refuses two blocks in one reply', () => {
    const twice = `${reply(PLAN)}\n\n\`\`\`task\n${JSON.stringify(PLAN)}\n\`\`\``;
    expect(readProposal(twice, PAGES).proposal).toBeNull();
  });

  it('the click creates the task with the plan section and the estimate, in one task.create', () => {
    const { proposal } = readProposal(reply(PLAN), PAGES);
    if (proposal?.action !== 'create') throw new Error('no create');
    expect(proposalCreate(proposal, 'm-1', 'c-1')).toStrictEqual({
      operationId: 'task-proposal:m-1',
      body: {
        fields: { title: PLAN.title, description: SECTION, estimated_minutes: 15 },
        conversationId: 'c-1',
      },
    });
  });

  it('the agent’s draft reads the plan from the task and asks one correction on the request’s shape', () => {
    const task = { id: '55555555-5555-4555-8555-555555555555', description: SECTION };
    expect(sitePlanRequest(task)).toStrictEqual({
      taskId: task.id,
      page: 'https://agencyastro.com/about',
      word: 'Based in Brisbane',
      replacement: 'Based in Townsville',
    });
    // A task whose description is not a whole plan section asks nothing.
    for (const description of [
      null,
      '',
      `${SECTION}\nMore words`,
      SECTION.replace('Client: internal', 'Client: Wattle Cafe'),
      'Two quotes.',
    ]) {
      expect(sitePlanRequest({ ...task, description })).toBeNull();
    }
  });
});
