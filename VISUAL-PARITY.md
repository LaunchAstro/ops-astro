# Projects and Tasks visual parity

Nathan's ruling R20261012 (12 October 2026) makes the running Hub mockup the canonical source for the layout and typography of Projects, Tasks and the Notifications, Agent, Clients and Projects dock panels. Data and licensed icon shapes may differ. The existing snapped type scale must not override the reference's intentional sizes, weights, line heights and spacing. Settings remains a full page and is removed from the shipped dock registry.

The CSS uses the existing type-census exception mechanism for measured reference styles that the older snapped scale cannot express. Every exception cites R20261012. This leaves the census active for all other rules and preserves its declared-style limit.

Shared custom selects retain the native select's form semantics and change events while providing the reference menu, selected tick and arrow. The native select is hidden from assistive technology and the visible button takes its accessible name. Keyboard navigation, disabled options, Escape, Tab and outside clicks use the same select controller.

Internal comments use an inline @ suggestion menu. The composer remains mounted when conversation tabs change, preserving caret position. Task ownership and grant changes clear drafts and suggestions according to the existing custody model. Client comments retain their own audience and never enable internal mention suggestions.

The subtask removal control uses the existing task.trash operation at the child's read revision. Human approval steps retain their gate action and do not gain a removal control. Time removal uses its existing operation. Both controls appear on hover or keyboard focus.

The execution map is rendered immediately below the agent run summary, from the admitted execution read. The old lower rendering is suppressed in the composed Agent view. Refusals, loading and permissions remain real states.

`node tests/visual/projects-task-states.ts --out <directory>` captures interaction states and inventories their control geometry using isolated synthetic reads. It intercepts every API write, so the visual sweep changes no application records. Screenshots distinguish those refused writes from successful production actions. Final delivery must include exact-head checks and independent review. The director and orchestrator own integration and merging.
