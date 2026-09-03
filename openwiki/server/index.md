# Files

- [AI generation gateway and task lifecycle](ai-generation.md) - Legacy and workspace AI generation planes, provider transports, prompt redaction, gateway task accounting, deterministic fallback, Auto decisions, and extension fallback rules.
- [Server API reference](api-reference.md) - Complete Express HTTP API reference for health, legacy generation, authentication, workspaces, providers, projects, environments, gateway tasks, and Auto decisions.
- [Server data model and persistence](data-model.md) - Postgres and Drizzle data model covering all platform tables, hard and soft relationships, tenant boundaries, IDs, migrations, task usage, and audit persistence.
- [Platform tenancy and RBAC](platform-and-rbac.md) - Authentication, workspace membership, exact role permissions, projects, environments, URL context resolution, provider precedence, tenancy, and unenforced policy flags.
- [BYO provider and secret security](provider-security.md) - Security model for workspace BYO LLM providers, AES-GCM secret storage, provider lifecycle, SSRF controls, DNS limitations, tenancy, and logging exposure.
