# Shared design system

This is the contract for the first UI transfer. It was written for the empty foundation. `packages/ui` now holds the transferred tokens, primitives, styles and surfaces. It ships no font files or icon assets: `packages/ui/src/styles/1-tokens.css` names the font families with system fallbacks, and controls that carry an icon in the mockup carry a word or an `aria-label` instead.

## One maintained design home

The product uses one shared UI package for reusable tokens, primitives and interaction patterns. Features compose that package. Add a needed shared variation there, with a typed interface; do not copy it into a feature stylesheet.

Use the approved existing application and frozen visual reference to choose each transferred surface. Record an exact source revision, component/stylesheet scope and required states before transferring it. The maintained application includes later intentional changes; the frozen reference remains evidence of the earlier agreed appearance. Do not mix their values for convenience, or undo an intentional update just because the frozen snapshot differs.

The private source-reference report accompanies local preparation. Future public transfers need a neutral, redistributable source/attribution record and relevant synthetic visual evidence. Never publish private reference routes or real user data.

## Preserve behaviour and meaning

Preserve typography, geometry, spacing, colours, navigation, keyboard operation, loading/empty/error states and responsive behaviour for the selected reference. A JavaScript-to-TypeScript conversion is not visual or behavioural proof.

Keep design tokens, stored user-selected colours and document/identity palettes distinct. A colour stored as data must not change when the application theme changes. Also preserve intentional CSS cascade order. Two rules at different semantic layers are not automatically redundant.

Print and email renderers may require output-specific adapters because they cannot consume the live application's CSS. They still need an explicit owner and a check against the shared values they represent. Do not create an untracked competing theme.

Check the redistribution rights of every icon, font and other asset before copying it. The existing foundation rule requires resolving the icon-set replacement before design files move. No unresolved asset ships by implication.

## First transfer

Start with the components the first task/review slice actually uses: task layout, actions, fields, menus, status indicators and empty/error states. Characterise their current behaviour, choose keep/adapt or redesign individually, and record the decision with the ticket. Do not bulk-import a component estate to build one screen.

The first UI ticket must provide:

- Typed component variants and supported inputs.
- Canonical tokens and a deliberate import order.
- Build checks against unapproved styling and duplicate registrations in owned UI paths.
- Behavioural tests through the component or visible task interface.
- Visual comparison against the pinned reference in the states and viewport sizes that matter.
- Keyboard, focus, disabled/loading and narrow-screen checks.
- A clear way to inspect each exported component from the capability map.

Source inspection is enough to establish this foundation contract. Screenshots become acceptance evidence when UI is transferred or a particular reference disagreement needs visual resolution. A full historical screenshot sweep is not a prerequisite for publishing an empty foundation.

## Changes after transfer

Change shared components in their shared home, inspect affected consumers and update the reference only when the intended behaviour or appearance changes. Keep one current contract and generated navigation. Preserve the old comparison as dated evidence rather than another active design authority.
