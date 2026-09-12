# Contributing to Braindump

Read [the engineering standards](docs/standards.md), [agent guidance](AGENTS.md) and [architecture](docs/architecture.md) before changing behavior. Preserve the user's live `data/` and user-provided import files; use temporary data for tests.

## Prepare and verify

```sh
bun install --frozen-lockfile
uv sync --locked --project scraper --python 3.13
bun run verify
```

The default checks need Bun and uv, but no running app, Ollama or Chromium. See [README.md](README.md#run-locally) to run the app, and [the standards](docs/standards.md#toolchain-and-commands) for individual check and formatting commands.

## Make a change

1. Check `git status --short` and preserve unrelated work.
2. Implement the smallest complete change within the existing architecture.
3. Add behavior/regression tests and update the affected documentation.
4. Run `bun run verify` and complete the applicable [manual checks](docs/standards.md#enforcement-and-review-evidence).
5. Use the [PR template](.github/pull_request_template.md) to record what changed and the evidence that it works.

Verification is also configured for pushes and pull requests in [the CI workflow](.github/workflows/verify.yml). Configure its `Repository standards` status as a required check on GitHub before relying on CI to prevent unchecked merges.
