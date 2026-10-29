# Contributing

[← README](README.md) · [Architecture](docs/architecture.md) · [Testing](docs/testing.md)

Keep contributions focused and document behavior that can be verified in the repository. Start by reading [AGENTS.md](AGENTS.md), the relevant source modules, and existing tests.

## Local workflow

1. Install Node.js 24 and run `npm ci`.
2. Follow the [quick start](README.md#quick-start) if your change needs a running application or real indexed documents. Offline tests do not require provider keys.
3. Plan significant changes, then implement small, focused edits using existing components where possible.
4. Run the relevant checks and inspect the complete diff before submitting a pull request.

```bash
npm run lint
npx --no-install tsc --noEmit
node --test tests/*.test.mjs
git diff --check
```

Run a [production build](docs/deployment.md#production-build) for changes that affect application compilation. Live checks are opt-in and can use provider quota; describe which checks you actually ran. Do not claim deployment, model accuracy, or live provider verification based only on mocked tests.

## Engineering expectations

- Keep provider keys and server-side logic on the server. Do not use `NEXT_PUBLIC_` for credentials or commit `.env.local`.
- Prefer simple solutions, strict TypeScript types, existing components, and existing dependencies.
- Handle loading, error, empty, and interrupted states. Preserve source metadata, page numbering, and response-local citation identity.
- Avoid unrelated file changes. Update documentation when API contracts, defaults, scripts, or setup requirements change.
- Before changing Next.js APIs or conventions, read the relevant installed guide in `node_modules/next/dist/docs/`, as required by `AGENTS.md`.

## Documentation and media

Use English, relative repository links, GitHub-compatible Markdown, and Mermaid for architecture diagrams. Keep private paths, credentials, raw provider errors, and unverified performance claims out of documentation.

Store real screenshots in [`docs/assets/`](docs/assets/README.md), include descriptive alt text, and record the capture state. Label wire-format examples and test fixtures clearly. Screenshots of simulated answers must not be presented as real model behavior.

## Pull request checklist

- [ ] Explain the concrete problem and resulting behavior.
- [ ] List relevant validation and any environment restrictions.
- [ ] Confirm that no secrets, private source data, or unrelated files are included.
- [ ] Update setup/configuration/API docs when their behavior changes.
- [ ] Check navigation, assets, and diagram rendering for documentation changes.

The repository currently has no license file. Do not add a license badge or imply a usage grant without an explicit license decision by the owner.
