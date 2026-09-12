# Engineering standards

These standards apply to maintained code, tests, configuration, assets and documentation. [AGENTS.md](../AGENTS.md) defines product and data-safety constraints; [the architecture guide](architecture.md) describes implementation contracts. This file defines how changes are written and verified. A change is ready only when the automated checks pass and its applicable review checks have evidence.

## Toolchain and commands

Use Bun for JavaScript dependencies and commands, and uv for Python. Keep `bun.lock` and `scraper/uv.lock` in the same change as their manifests. JavaScript dependencies use exact versions, including development tools. Python dependencies resolve through the locked uv environment. Add a dependency only when an existing dependency or platform API does not meet the need; explain its purpose in the change description.

`package.json` pins the Bun version in `packageManager`; CI reads that value. CI also pins uv and selects Python 3.13, matching the setup script. GitHub Actions use full commit SHAs, with the release family recorded in a comment. Verify those SHAs against the upstream repository when updating them.

Dependency refreshes use `bun update --latest` and `uv lock --project scraper --upgrade`, after checking direct Python requirements for newer stable releases. Sync the Python environment, run `bun audit`, and complete `bun run verify`; an unchanged direct version does not mean its transitive dependencies are current. Keep upstream compatibility constraints unless an override has a concrete reason and validation.

As of 12 September 2026, `package.json` overrides `lodash-es` to 4.18.1 and `smol-toml` to 1.8.0 because the latest Mermaid/Chevrotain and Markdownlint dependencies still select vulnerable releases. These address [Lodash template injection](https://github.com/advisories/GHSA-r5fr-rjxr-66jc), [Lodash prototype pollution](https://github.com/advisories/GHSA-f23m-r3pf-42rh), and [smol-toml denial of service](https://github.com/advisories/GHSA-7w5x-hrqm-74c2). Both overrides affect development tooling; the documentation checks exercise their consumers. Remove the overrides once upstream resolves patched versions without them. Python's `pyee` stays on 13.0.1 because the current Playwright and Patchright releases require `<14`; do not force version 14 past that constraint.

```sh
bun install --frozen-lockfile
uv sync --locked --project scraper --python 3.13
bun run verify
```

`verify` stops at the first failure and exits nonzero. It checks lockfiles, JavaScript security advisories with `bun audit`, repository rules, formatting, TypeScript/React/accessibility lint, Markdown style, local document links and anchors, Mermaid syntax, Python lint, Bun tests, Python tests, and the production build/typecheck. It does not start the app, import user data, launch a browser, or call a model. Dependency checks may contact package registries; application integration tests use temporary data and no live services. The default Python transport tests bind disposable loopback servers; they make no external website requests.

Use `bun run format` to apply Prettier and Ruff formatting. To avoid unrelated changes during focused work, use `bunx --no-install prettier --write path/to/file.ts` or `uv run --locked --project scraper ruff format path/to/file.py`. Formatting is mechanical; review the diff before handoff. `bun run verify` checks without rewriting maintained files or lockfiles.

## Code structure and naming

| Kind                         | Location and naming                                         | Responsibility                                             |
| ---------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| React screens and components | `src/components/PascalCase.tsx`                             | UI state and interaction; reuse existing shadcn primitives |
| shadcn primitives            | `src/components/ui/kebab-case.tsx`                          | Shared accessible controls; retain upstream conventions    |
| Browser helpers              | `src/lib/kebab-case.ts`                                     | Shared browser behavior, without server I/O                |
| Backend modules              | `server/kebab-case.ts`                                      | API, persistence, jobs, network boundaries and model work  |
| Operational/check scripts    | `scripts/kebab-case.ts`, helpers in `scripts/checks/`       | Explicit commands with useful errors and exit statuses     |
| Bun tests                    | `tests/kebab-case.test.ts`                                  | Isolated unit, database, API and tooling regression tests  |
| Python                       | `scraper/snake_case.py`, tests in `scraper/tests/test_*.py` | Extraction bridge and offline boundary tests               |
| Documentation                | `docs/kebab-case.md`                                        | Durable implementation and contributor guidance            |

`src/App.tsx`, `src/main.tsx`, `src/types.ts`, root configuration files and root contributor documents keep their established names. Put new code beside the feature it belongs to. Extract a shared helper when multiple callers need the same behavior; do not create generic infrastructure for a single hypothetical future use.

Use camelCase for values and functions, PascalCase for types and React components, and descriptive names that communicate domain meaning. Export types with `export type` when they do not carry runtime values. Browser imports use `@/` within `src`; backend and scripts use relative paths and explicit `node:` imports for Node built-ins. Browser code may use shared schemas from `server/schema.ts` and shared types, but must not import server implementation values or Bun/Node I/O. The server must not import UI modules.

`check:repo` uses Bun's parser to check statically named runtime imports, re-exports and dynamic imports against those browser/server boundaries. Type-only imports are erased by the parser. Do not construct module paths dynamically to bypass this boundary; computed paths and type dependencies require review.

## Formatting and correctness

- Text uses UTF-8, LF endings, a final newline and no trailing whitespace. Prettier owns TypeScript, TSX, CSS, HTML, JSON, YAML and Markdown formatting: two spaces, double quotes, semicolons and trailing commas. Prose is not forcibly wrapped. Ruff owns Python formatting: four spaces and an 88-column target. SVG assets receive the text checks and a manual visual review. `.editorconfig` matches these choices.
- Keep TypeScript strict. Do not add explicit `any`, `@ts-ignore` or `@ts-nocheck`. Narrow external data from `unknown` with the existing Zod schemas or explicit guards. A justified `@ts-expect-error` needs an explanation and a regression case.
- Await or return promises. Use `void` only for intentional background/event work whose errors are handled inside the called operation or by an attached rejection handler. Lint verifies explicit promise handling; review verifies that error handling is meaningful.
- Use strict equality. Remove unused bindings and debugger statements. Empty catch blocks need a comment explaining why ignoring that failure is correct.
- Keep React hooks unconditional and dependencies complete. Use native controls and accessible names. Images have alt text or are explicitly decorative. Controls remain usable with a keyboard. Preserve loading, empty, error and mobile states.
- Use semantic theme tokens for application colors instead of hardcoded light surfaces or text. The navy sidebar and original favicon colors are intentional fixed palettes. Check light and dark variants of affected desktop/mobile states, including focus rings, dialogs, errors and native controls. Browser review verifies contrast and that theme changes preserve the current view. The pre-paint theme script in `public/` is included in JS lint and isolated bootstrap tests.
- Use English title case for app-owned page, section, dialog, navigation, form-label and browser-tab titles, including empty/error headings. Capitalize the first and last word and major words; keep internal minor words such as “a”, “and”, “of” and “the” lowercase. Preserve acronyms, deliberate brand casing and technical identifiers. Imported link titles, tag values and URLs retain their original casing everywhere, including notifications, accessible names and quoted values within app titles. Body copy remains sentence case. Desktop/mobile review checks app-title casing, source-title preservation and layout.
- React Compiler optimization diagnostics `set-state-in-effect` and `purity` are deliberately disabled: the app is not compiled with React Compiler and uses polling/effect synchronization. Hooks, dependency and accessibility checks remain enabled. Review still checks render/effect behavior.

Prefer small changes with explicit data flow. Validate at HTTP, subprocess, model and restore boundaries. Keep transactions synchronous; preserve schema migrations, queue deduplication and retry behavior, and update current records after asynchronous work. These contracts are covered in [the architecture guide](architecture.md#data-and-invariants) and [agent guidance](../AGENTS.md#implementation-rules).

## Tests

Write tests for observable behavior and failure cases. Name each test as a sentence describing a condition and its result. Arrange the inputs, invoke the public operation, then assert its externally meaningful result. A regression test must fail without the corresponding fix.

- Bun tests import from `bun:test`. Use temporary directories for stores and fixtures; close databases and remove temporary files in `afterEach` or `finally`. Never use `data/` or modify user-provided import files in tests.
- Default Bun and Python tests run without Ollama, Chromium or live website requests. Inject fake transports/results or mock the external boundary. Put live extraction/inference checks in the explicit `bun run test:live` workflow, with temporary data.
- Do not leave focused, skipped, conditional or todo tests in the default suite. Oxlint restricts `.only`, `.skip`, `.todo`, `.skipIf` and `.runIf` properties in test files, including aliased Bun imports. Each test must make a meaningful assertion; do not weaken an assertion to make a failure pass. Test isolation, assertion quality and network independence remain review obligations in addition to lint.
- For persistence changes, cover index consistency, status preservation, old records/backups, rollback and migrations as applicable. Lists must keep memberships through reanalysis/status edits, reject duplicate names and dangling backup references, and preserve links when a list is deleted; `tests/lists.test.ts` verifies these contracts. For queue changes, cover ordering, retries, deduplication and recovery. For parsers/network code, cover malformed input, limits and rejected destinations. For standards tooling, include invalid fixtures that prove rejection.
- Do not add snapshots of large generated output, tests of private implementation details, or tests that merely restate a CSS/JSX change. Use browser inspection for presentation changes and behavior tests where an interaction has meaningful logic.

`bun run test:coverage` runs both offline suites with coverage and is included in `bun run verify`, so CI prints the reports without running the suites twice. `bun run test:coverage:bun` and `bun run test:coverage:python` run either side independently. Bun writes `coverage/bun/lcov.info`; Coverage.py writes `coverage/python/html/index.html` and `coverage/python/coverage.json`. Coverage.py is a locked development dependency, used because Bun cannot instrument Python. Generated coverage files stay out of Git.

Bun measures only source modules loaded in its test process, excluding test helpers via `bunfig.toml`. It does not include browser-only components, unimported entry points, the theme bootstrap evaluated in a VM, or source exercised by subprocess fixtures. Python measures the scraper's statements and branches, excluding test code via `scraper/pyproject.toml`. Compare the same file set before and after a change and report these scope limits; never present the Bun total as whole-application coverage. Do not exclude production code just to improve a percentage.

There is no arbitrary coverage percentage. Review checks whether the changed behavior and its important failure modes are covered. `bun run test:browser` checks actual Chromium against disposable local servers for extraction transport changes; it is separate from the default browser-free suite. High coverage from fake transports does not prove real DNS, redirects or browser behavior; retain the applicable live and visual checks. Passing tests do not prove an entire imported library has been summarized.

## Documentation

Use one descriptive H1, sequential heading levels, fenced code blocks with a language, and descriptive links. Markdownlint checks structure; Prettier checks formatting. Local links must resolve inside the repository, including Markdown heading anchors. External URLs are reviewed for relevance but are not fetched by the automated gate, avoiding flaky checks and unintended network requests.

Mermaid diagrams must parse using the pinned Mermaid dependency. The check uses a DOM sanitizer for parsing only; it does not render screenshots or verify architectural accuracy. Use the existing flowchart conventions and review the rendered diagram after changing its layout. Diagram arrows must match the implementation.

Keep documentation with the change that affects it:

| Change                                                               | Required documentation                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Setup, commands, configuration or user workflow                      | `README.md`                                                               |
| API, data/schema, jobs, extraction/model, backup or network contract | `docs/architecture.md`                                                    |
| Agent workflow or safety invariant                                   | `AGENTS.md`                                                               |
| Engineering rule or verification tool                                | This file, its configuration/check, and regression tests where applicable |

Describe current behavior and limits. Give exact commands and repository-relative paths. Do not store transient PIDs, queue counts, local test logs, secrets or machine-specific scratch paths in contributor documents. Link to authoritative sources when describing external behavior that may change; state the date for time-sensitive model/tool claims.

## Enforcement and review evidence

| Standard                                   | Automated enforcement                                                                                        | Review evidence still needed                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Formatting and file conventions            | Prettier, Ruff, `.editorconfig`, `check:repo`                                                                | Appropriate module ownership and readable names                                       |
| TypeScript, promises, hooks, accessibility | Strict typecheck and Oxlint with type-aware rules; warnings fail                                             | Correct behavior, meaningful error handling and keyboard/mobile usability             |
| Tests                                      | Bun and Coverage.py/unittest reports, focused/disabled-test property lint, invalid-fixture tests for tooling | Assertions cover the change; fixtures are isolated; default tests avoid live services |
| Documentation                              | Markdownlint, AST-based local link/anchor checks and Mermaid parsing                                         | Accurate contracts, useful prose and readable rendered diagrams                       |
| Dependencies and Git hygiene               | Frozen/check-only lock checks, Bun dependency audit, exact JS pins, ignored-source and tracked-data checks   | Dependency justification and upstream action-SHA verification                         |
| CI                                         | Push/PR workflow using `bun run verify`, read-only permissions and pinned actions; workflow-policy checks    | Hosted run result and repository branch protection                                    |

The [PR template](../.github/pull_request_template.md) records the change, automated result and applicable manual evidence. UI changes need desktop/mobile inspection and keyboard checks; extraction/model changes need the isolated live check when dependencies are available. Report any unavailable verification explicitly. Never treat a build as visual verification or claim a live check passed when work was only queued.

Do not silently bypass checks. A narrow rule suppression must name the rule and explain the concrete exception beside the code. Changing a shared standard requires updating this document, the enforcing configuration and its verification together. Unused suppressions fail lint. A CI failure must be fixed before merging; configure the hosted `Repository standards` check as required in branch protection when this repository is connected to GitHub. A workflow file alone cannot enforce the hosting service's merge settings.
