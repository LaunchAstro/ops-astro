// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-shadow, unicorn/no-array-sort -- Sol's proof, kept as written */
import { expect, it } from 'vitest';
import { scopeChoices } from '../../packages/core-records/src/mandates/mandates.ts';
import { GRADUATION } from '../visual/made-up-connections.ts';
import { CONNECTIONS } from '../visual/look/connections.ts';

it('every promoted made-up row has a live matching mandate', () => {
  for (const row of GRADUATION.rows.filter((row) => row.state === 'promoted')) {
    expect(
      GRADUATION.mandates.some(
        (mandate) =>
          mandate.clientId === row.clientId &&
          !mandate.refuses &&
          !mandate.expired &&
          mandate.graduationClass === row.actionClass,
      ),
      row.id,
    ).toBe(true);
  }
});

it('made-up clients follow the main name order', () => {
  const labels = GRADUATION.clients.map((client) => client.label);
  expect(labels).toEqual(
    [...labels].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase())),
  );
});

it('made-up scopes are the choices main derives from each client own rows', () => {
  for (const client of GRADUATION.clients) {
    const own = GRADUATION.rows
      .filter((row) => row.clientId === client.id)
      .map((row) => row.actionClass);
    expect(client.scopes, client.label).toEqual(scopeChoices(own));
  }
});

it('the grants-group probe measures the drawn background', () => {
  const probe = CONNECTIONS.probes.find((probe) => probe.id === 'connections.grants-group');
  expect(probe?.props).toContain('background-color');
  expect(probe?.props).not.toContain('border-bottom-color');
});
