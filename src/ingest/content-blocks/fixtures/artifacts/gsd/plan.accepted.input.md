---
phase: 62
plan: fix-backend-types
type: implementation
files_modified:
  - src/services/auth.ts
must_haves:
  - typecheck passes
requirements:
  - REQ-17
---
# Fix backend types

<objective>
Resolve backend type failures without changing auth behavior.
</objective>

<tasks>
<task type="auto">Update `src/services/auth.ts` to narrow nullable users.</task>
</tasks>

## Verification

- [ ] Run `bun test src/services/auth.test.ts`
- [ ] Run `bun run typecheck`

<success_criteria>
No new TypeScript errors.
</success_criteria>
