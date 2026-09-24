# Changelog

## [Unreleased]

## [0.1.3] - 2026-09-24

First tagged release from this repository.

### Added

- Initial standalone `apply_patch` pi extension.
- Support GPT models exposed through custom `openai-responses` and `openai-codex-responses` providers (#33, thanks @zidou-kiyn).

### Fixed

- Keep the final diff preview on completed results so the diff no longer disappears after the patch applies, and accept absolute and outside-cwd paths (#22, thanks @bstncartwright; fixes #16, #21, #23).
- Serialize file mutations per canonical path (#28, thanks @alexei-ciobanu).
- Disclose `apply_patch` failure reasons and classify recovery advice (#34).

### Changed

- Dependencies (#40, fixes #39): `@biomejs/biome` 2.5.5 -> 2.5.14, `vitest` ^4.1.10 -> 5.0.1, `@types/node` ^26.1.1 -> 26.6.2, `@typescript/native-preview` pinned to 7.0.0-dev.20260707.2, `typescript` stays 7.0.2. `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent` and `pi-tui` are now exact 0.87.1 devDependencies so tests run against the current upstream runtime.
- `typebox` moved from `peerDependencies` to `dependencies` (^1.3.34). Peer dependencies now list only `@earendil-works/pi-*` (range `*`). The pi extension loader still aliases `typebox` to the host copy.
- `engines.node` raised to `>=22.19.0`, matching `@earendil-works/pi-coding-agent` 0.87.1.
- Biome config migrated (`linter.rules.recommended` -> `linter.rules.preset`).
- The published tarball is limited to `src/`, README, CHANGELOG, LICENSE and NOTICE through a `files` allowlist.
- CI now runs on Bun 1.4.2 (#40) (`oven-sh/setup-bun@v2`) across ubuntu/macos x Node 22/24 with `actions/checkout@v7` and `actions/setup-node@v7`, plus an `npm ci && npm test` consumer job. The publish workflow verifies with Bun and still publishes with `npm publish --provenance`. `bun.lock` is committed alongside `package-lock.json`.
