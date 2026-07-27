## Git commit conventions

When creating commits, use Conventional Commits:

`<type>(optional-scope): description`

Allowed types include:
- `feat`
- `fix`
- `refactor`
- `docs`
- `test`
- `build`
- `ci`
- `chore`
- `perf`
- `revert`

Use lowercase, imperative descriptions, and no trailing period.
Example: `refactor: simplify authentication flow`

Only create commits when explicitly requested.

## Subagents

The primary agent should use the `subagent` tool whenever work can be usefully isolated: delegate independent research, reconnaissance, mechanical implementation, and commit preparation rather than doing those tasks in the primary context. Use parallel subagents for independent tasks. Do not delegate trivial work, and do not ask subagents to recursively delegate work.

Available fast subagents:
- `docs`: documentation and web/local-doc research. Use for APIs, config options, current external facts, examples, and source URLs.
- `scout`: codebase reconnaissance. Use for finding files, symbols, call sites, tests, conventions, and relevant implementation context.
- `writer`: focused implementation. Use for well-specified, mechanical file changes, boilerplate, docs, tests, and fixtures.
- `committer`: careful commit creation. Use only after an explicit request to commit ready, identified files; it reviews, stages, validates, and creates a Conventional Commit.

`docs`, `scout`, and `writer` use the small, fast `openai-codex/gpt-5.4-mini:off` model. `committer` uses `openai-codex/gpt-5.6-luna` for more careful diff and commit review. Keep delegated tasks narrow and ask subagents to return concise, path-specific findings or change summaries.
