# Technical references and proof limits

These references support the current design. They are reading entry points,
not claims that their latest versions, a deployment, or the product integration
were verified for this foundation. Pin and inspect the relevant release when
an implementation ticket depends on an API, licence, or security property.

| Question                                             | Primary reference                                                                                                                                                          | Relevance to this project                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| How are row policies and referential checks applied? | [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)                                                                                    | Business isolation needs composite relationships and explicit privileged-path tests.                    |
| What does a schema change lock or rewrite?           | [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)                                                                                      | Fixed typed slots avoid runtime schema changes for indexed fields.                                      |
| What owns identity and access?                       | [Supabase Auth](https://supabase.com/docs/guides/auth) and [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)                     | The product keeps its own permissions contract and tests access through real API and database paths.    |
| What does the selected tracing service require?      | [Langfuse self-hosting](https://langfuse.com/self-hosting) and [upstream licence](https://github.com/langfuse/langfuse/blob/main/LICENSE)                                  | A pinned service profile needs dependency, licence, access, retention, and recovery review.             |
| What would an agent framework add?                   | [LangChain stack comparison](https://docs.langchain.com/oss/javascript/concepts/products) and [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview) | Candidates require a bounded comparison that reduces owned complexity. None is selected.                |
| What happens when agent work resumes?                | [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) and [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)  | A candidate must share one recovery owner with product effect handling and preserve approved scope.     |
| How does the repository route work?                  | [Matt Pocock skills](https://github.com/mattpocock/skills)                                                                                                                 | The vendored specification, ticket, implementation, and review workflow is the sole router.             |
| Where do the selected standards come from?           | [Pstack](https://github.com/ericlitman/open-pstack)                                                                                                                        | Selected vendored standards supplement that workflow. Notices and pinned source versions are in NOTICE. |

The private archive retains the raw research and original decisions. The
public technical evidence digest and adjudicated verdicts are a separate
outstanding deliverable. This reference table does not complete it.
