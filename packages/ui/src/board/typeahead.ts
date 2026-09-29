// SPDX-License-Identifier: AGPL-3.0-only
//
// The search field's suggestions (MP-5-5, B-03, R46). Nothing below two
// characters: one letter matches everything and teaches nothing. Matching is
// on word starts. The groups come in a fixed order, clients, then every other
// filter, then row names, so the filters are never pushed below the fold by a
// long list of names (the mockup's D-20). Five per group, and a group that
// left some out says how many.
//
// Suggestions come only from the facets and names handed in, which are built
// from the rows the viewer may read.

import { startsAWord } from './filters.ts';
import type { Facet, Filters, SuggestionGroup, SuggestionItem } from './types.ts';

export const SUGGESTIONS_PER_GROUP = 5;

const asItem = <Row>(facet: Facet<Row>): SuggestionItem => ({
  kind: facet.kind,
  label: facet.label,
  facetId: facet.id,
});

export function suggest<Row>(options: {
  readonly q: string;
  readonly facets: readonly Facet<Row>[];
  readonly names: readonly string[];
  readonly noun: string;
  readonly have: Filters;
}): readonly SuggestionGroup[] {
  const q = options.q.trim().toLowerCase();
  if (q.length < 2) return [];
  const hit = (facet: Facet<Row>): boolean =>
    !options.have.ids.includes(facet.id) &&
    (startsAWord(facet.label, q) || (facet.words ?? []).some((word) => startsAWord(word, q)));
  const clients = options.facets.filter((facet) => facet.kind === 'Client' && hit(facet));
  const others = options.facets.filter((facet) => facet.kind !== 'Client' && hit(facet));
  // A row that is itself a client (the clients board) is already offered above.
  const clientLabels = new Set(
    options.facets
      .filter((facet) => facet.kind === 'Client')
      .map((facet) => facet.label.toLowerCase()),
  );
  const names = [...new Set(options.names)].filter(
    (name) =>
      startsAWord(name, q) &&
      !clientLabels.has(name.toLowerCase()) &&
      !options.have.text.includes(name.toLowerCase()),
  );
  const noun = `${options.noun.charAt(0).toUpperCase()}${options.noun.slice(1)}s`;
  const group = (label: string, items: readonly SuggestionItem[]): SuggestionGroup[] =>
    items.length === 0
      ? []
      : [
          {
            label,
            items: items.slice(0, SUGGESTIONS_PER_GROUP),
            more: Math.max(0, items.length - SUGGESTIONS_PER_GROUP),
          },
        ];
  return [
    ...group('Clients', clients.map(asItem)),
    ...group('Everything else', others.map(asItem)),
    ...group(
      noun,
      names.map((name) => ({ kind: 'Name', label: name, text: name.toLowerCase() })),
    ),
  ];
}
