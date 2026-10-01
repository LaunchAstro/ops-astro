// Sol proof (SL12 take, 5930cc2): the ratchet split must not drop a positive
// control recipe. Every recipe is reached with a context whose every call
// throws a sentinel; a declaration with a recipe throws the sentinel, one
// without throws "no positive control recipe".
import { describe, expect, it } from 'vitest';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { createPositiveBody } from '../acceptance/role-case-positive-body.ts';

const REACHED = 'recipe reached';
// oxlint-disable-next-line eslint/require-await -- the reviewer's proof, kept as written
const reached = async (): Promise<never> => {
  throw new Error(REACHED);
};

describe('SL12 take ratchet split', () => {
  it.each(['task.heartbeat', 'task.dispatch'] as const)(
    'Sol proof, criterion 4: the positive control still has a recipe for %s',
    async (name) => {
      const declaration = COMMAND_SURFACE.find((each) => each.name === name);
      expect(declaration, name).toBeDefined();
      const positiveBody = createPositiveBody({
        alphaTaskId: '00000000-0000-4000-8000-000000000001',
        assigneePersonId: '00000000-0000-4000-8000-000000000002',
        asPerson: reached,
        asAgent: reached,
        freshTask: reached,
      } as never);
      const outcome = await positiveBody(declaration!).then(
        () => 'returned',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(outcome).not.toMatch(/no positive control recipe/u);
    },
  );
});
