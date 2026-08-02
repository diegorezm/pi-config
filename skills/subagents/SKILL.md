---
name: subagents
description: Delegate coding-agent work to specialized subagents when independent research, reconnaissance, mechanical implementation, or commit preparation can be usefully isolated. Use when a task has a separable non-trivial workstream.
---

# Subagents

Use the `subagent` tool when work can be usefully isolated. Delegate independent research, reconnaissance, mechanical implementation, and commit preparation instead of doing those workstreams in the primary context.

- Use parallel subagents for independent tasks.
- Do not delegate trivial work.
- Do not ask subagents to recursively delegate.
- Keep tasks narrow and request concise, path-specific findings or change summaries.

## Available Subagents

- `docs`: Documentation and web/local-doc research. Use for APIs, config options, current external facts, examples, and source URLs.
- `scout`: Codebase reconnaissance. Use for files, symbols, call sites, tests, conventions, and relevant implementation context.
- `writer`: Focused implementation. Use for well-specified, mechanical file changes, boilerplate, docs, tests, and fixtures.
- `committer`: Careful commit creation. Use only after an explicit request to commit ready, identified files; it reviews, stages, validates, and creates a Conventional Commit.

`docs`, `scout`, and `writer` use `openai-codex/gpt-5.4-mini:off`. `committer` uses `openai-codex/gpt-5.6-luna`.
