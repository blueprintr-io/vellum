# Contributing

Thanks for considering a contribution. A few ground rules so your time
isn't wasted. The [Code of Conduct](./CODE_OF_CONDUCT.md) applies to
everyone interacting with this repo, contributors included — read it
first if you haven't.

## Licensing of contributions (read this first)

Vellum is released under [PolyForm Noncommercial 1.0.0](./LICENSE).

By opening a pull request, you agree that your contribution is
dual-licensed: under the same PolyForm Noncommercial 1.0.0 as the rest
of the project for public use, **and** under a non-exclusive, worldwide,
perpetual, royalty-free licence to the copyright holder for any
purpose, including derivative works that fall outside the noncommercial
licence terms. This avoids the copyright holder having to re-negotiate
with each contributor whenever the project's licensing arrangement
changes.

You also grant the copyright holder a non-exclusive, worldwide,
royalty-free patent licence covering any patent claims you hold that
read on your contribution.

You retain copyright on what you write. You're not assigning anything;
you're granting a licence. You are also confirming that the contribution
is yours to grant — i.e., your employer or any contract you've signed
doesn't preclude it.

If that's not OK with you, please don't submit code. Bug reports and
issue comments are still welcome and have no licensing implications.

## Before you start

- Open an issue describing the problem or feature first if it's
  non-trivial. PRs that change the file format, the public API
  (`src/index.ts`), or the keyboard model should expect more discussion.
- Vellum is opinionated. "Add a setting for X" is a harder sell than
  "X is the right default because Y."

## Local setup

```sh
npm install
npm run dev          # http://localhost:5173
npm run typecheck    # tsc -b --noEmit
npm run build        # production bundle to dist/
```

Node 20+ recommended. The repo has no test suite yet — verification is
manual against the dev server.

## Code conventions

- TypeScript strict. Avoid `any`; if you really need it, leave a
  one-line comment explaining why.
- React function components with hooks. No class components.
- State lives in `src/store/editor.ts` (Zustand). The Canvas reads, the
  chrome dispatches actions; rendering stays pure.
- The on-disk shape and the in-memory shape are the same object. No
  DTOs, no `toJSON`. If you change a type, change the schema in
  `src/store/schema.ts` in the same commit.
- Tailwind for layout; design tokens live in `src/styles/tokens.css`.
  Don't introduce a new colour without adding a token.

## Security-sensitive areas

If your change touches any of the following, please flag it explicitly
in the PR description:

- `src/lib/sanitize-svg.ts` — the DOMPurify wrapper.
- `src/store/schema.ts` — the Zod parsers; every load boundary uses these.
- `src/store/persist.ts`, `src/editor/useAutosave.ts`,
  `src/editor/canvas/Canvas.tsx` (drop/paste handlers) — each one is a
  place where foreign data enters the store. Anything that lands in the
  store *must* go through the schema first.
- `index.html` — the CSP meta tag is the last line of defense if a
  sanitizer bypass slips through. Don't relax it casually.

## Commit and PR style

- One logical change per commit.
- No drive-by reformatting in the same diff as a behaviour change.
- Commit message summary line in the imperative ("Fix marquee
  selection on rotated tables"), body explaining the why.
- If you can describe the fix in two sentences, two sentences is
  enough.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened,
your browser + OS. A `.vellum` file that reproduces the issue is gold.

## Reporting security issues

See [SECURITY.md](./SECURITY.md). Please do not open a public issue
for security findings.
