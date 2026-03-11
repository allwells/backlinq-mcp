---
trigger: always_on
---

# Backlinq — Global Agent Rules

# These rules are ALWAYS active. Never ignore them.

---

## 1. Language & Type Safety

- TypeScript strict mode ALWAYS. `tsconfig.json` must have `"strict": true`
- Never use `any`. Use `unknown` and narrow it, or define a proper interface
- Every function must have explicit parameter types and return types
- Every API response must be typed via an interface in `src/types/index.ts`
- Use `readonly` on interfaces where data should not be mutated
- Prefer `type` for unions/primitives, `interface` for object shapes

## 2. Code Structure & Cleanliness

- One responsibility per file. Adapters fetch data. Tools use adapters. Utils are pure functions
- No business logic in `index.ts` — it is an entry point only
- No direct API calls inside tool handlers — always go through an adapter
- Max function length: 40 lines. If longer, decompose
- No nested callbacks. Use async/await exclusively
- No magic numbers or strings — use named constants

## 3. Error Handling

- Every adapter must have try/catch and return a typed Result or throw a typed Error
- Tool handlers must never let unhandled exceptions crash the MCP server
- All errors returned to MCP must be structured: `{ error: true, code: string, message: string }`
- Log every error with context using `src/utils/logger.ts`
- Timeouts: every external API call must have a timeout of max 25 seconds (5s buffer before CTX's 30s limit)

## 4. File & Folder Rules

- Never create files outside the structure defined in `.context.md`
- Never commit `.env` — use `.env.example` for documentation
- All new types go in `src/types/index.ts` — never define types inline in tool or adapter files
- Test files mirror source structure under `tests/`

## 5. API & Performance Rules

- Every external API call must be wrapped with a 25-second timeout
- Prefer parallel API calls (`Promise.all`) over sequential when data is independent
- Cache repeated identical requests within the same tool call using a simple in-memory Map
- Never return raw API responses to the MCP client — always transform to a clean typed response

## 6. Naming Conventions

- Files: `camelCase.ts`
- Types/Interfaces: `PascalCase`
- Functions: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- MCP tool names: `snake_case` (e.g., `get_backlink_profile`)

## 7. Phase Discipline

- Only work on the current phase as defined in `.context.md`
- After completing a phase, update the checklist in `.context.md` by marking items with `[x]`
- Never start the next phase without explicit user confirmation
- If a task in the current phase is blocked, report the blocker clearly — do not skip it silently

## 8. Testing Rules

- Every adapter must have at least one test that calls a real domain (`example.com`)
- Every tool must have at least one happy-path test and one error-path test
- Never mock the entire adapter in tool tests — use real adapter behavior where possible
- Run `tsc --noEmit` before declaring any phase complete. Zero type errors required

## 9. Dependency Rules

- Only install packages that are strictly necessary
- Never install a package that duplicates Node.js built-in functionality
- Keep `devDependencies` separate from `dependencies`
- Approved packages only:
  - `@modelcontextprotocol/sdk`
  - `@ctxprotocol/sdk`
  - `dotenv`
  - `axios` or native `fetch` (pick one, stick to it)
  - `zod` (for runtime validation if needed)
  - `vitest` or `jest` (testing)
  - `typescript`, `tsx`, `@types/node` (dev)

## 10. Communication Rules

- After every file created, state clearly: filename, location, and what it does
- If you are unsure about something, ask before implementing
- Never assume an environment variable is set — always validate at startup and throw a clear error if missing
