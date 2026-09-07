# Multi-Tenant Helpdesk — Codex Instructions

## Project purpose

This is a serious backend engineering portfolio and learning project.

The goal is not only to produce working code. Important implementation and
architecture decisions must remain understandable and defensible by the
developer.

Do not introduce complexity or technologies merely for demonstration or CV
keywords.

## Development philosophy

- Requirements and concrete problems come before technologies.
- Prefer the simplest solution that satisfies the current requirements.
- Do not perform unrelated refactors while implementing a bounded task.
- Do not add abstractions until there is a concrete problem or meaningful
  duplication that justifies them.
- Do not add new production dependencies unless the task explicitly requires
  one or there is a clear justification.
- Keep implemented functionality fully runnable and testable locally.
- Production-compatible design is welcome, but do not implement behavior that
  requires an actual deployment or fake external service to function.

## Stack

- Node.js
- TypeScript
- Express
- PostgreSQL
- Kysely
- pg
- Vitest
- Supertest
- Zod
- Argon2id

The project uses ESM and TypeScript NodeNext configuration.

## Application architecture

Use the existing flow:

HTTP
→ authentication / request context
→ validation
→ controller
→ service
→ repository
→ Kysely
→ PostgreSQL

Responsibilities:

- Controllers handle HTTP concerns and should remain thin.
- Services own business rules, authorization decisions, orchestration, and
  transaction boundaries.
- Repositories own persistence and tenant-scoped database queries.
- PostgreSQL owns durable structural integrity.

Do not introduce generic base repositories, generic service frameworks, or
similar abstractions without a concrete requirement.

## Multi-tenancy — critical security requirement

Tenant isolation is fundamental.

- Never trust an organization ID supplied by the client as the authority for
  tenant identity.
- Authenticated tenant identity must come from the verified server-side
  authentication context.
- Tenant operations must be explicitly scoped to the authenticated
  organization.
- Treat possible cross-organization data access as a critical security bug.
- Preserve tenant-aware database relationships and composite foreign-key
  patterns where applicable.
- Do not rely on globally unique UUIDs alone for tenant relationship safety.

When reviewing or implementing tenant-related code, actively check for
cross-tenant access paths.

## Transactions and concurrency

- Services own transactions when multiple persistence operations form one
  atomic business operation.
- Repositories should work with the normal Kysely database instance or a
  service-provided transaction context.
- Do not introduce global SERIALIZABLE isolation.
- For concurrency-sensitive behavior, reason explicitly about races, locking,
  revalidation, and PostgreSQL READ COMMITTED behavior.

## Authentication

Authentication is intentionally mature. Do not simplify away agreed security
features.

The design includes:

- Argon2id password hashing.
- Opaque PostgreSQL-backed sessions.
- Only hashes of session secrets stored in PostgreSQL.
- HttpOnly session cookies.
- Idle and absolute session expiration.
- Individual and global session revocation.
- Multiple session/device awareness.
- Immediate user and organization deactivation effects.
- Generic authentication failures.
- Explicit CSRF protection.
- Login throttling.
- Separate tenant-user and SYSTEM_ADMIN authentication domains.
- Mandatory TOTP MFA and recovery codes for SYSTEM_ADMIN.

Do not replace this design with stateless JWT authentication unless the
requirements are deliberately changed first.

## Testing

Testing should be pragmatic and lightweight.

Focus tests on important behavior such as:

- tenant isolation;
- authorization;
- authentication/security;
- transactions;
- concurrency-sensitive behavior;
- important business invariants.

Do not chase coverage percentages or add elaborate test infrastructure without
a concrete need.

Run focused checks appropriate to the task. Do not repeatedly run the full test
suite for trivial edits when no meaningful risk justifies it.

## Database safety

- Do not run destructive commands against the development database unless the
  task explicitly requires it.
- Automated tests must use the dedicated test database.
- Do not bypass Kysely with raw pg queries in normal repository code unless
  there is a specific justified need.
- Migration code uses the migrator database identity; runtime application code
  uses the restricted application identity.

## Secrets

- Do not read, print, expose, or modify `.env` secrets.
- Use `.env.example` to understand configuration names.
- Never include passwords, database credentials, session tokens, or secret
  values in summaries or generated code.

## Git

- Do not commit, push, reset, rebase, force-push, or rewrite Git history unless
  explicitly requested.
- Keep each task bounded so its diff is easy to review.
- Do not discard existing user changes.

## Working style

Before editing:

1. Inspect the relevant existing code.
2. Follow existing naming and architectural patterns.
3. Identify assumptions that materially affect the implementation.

After editing:

1. Review the diff for unrelated changes.
2. Run the smallest meaningful validation for the change.
3. Report:
   - what changed;
   - important design decisions made;
   - commands/checks run;
   - anything uncertain or needing human review.

For security-, authorization-, tenant-, transaction-, or concurrency-sensitive
changes, explicitly call out the relevant risks in the final summary.
