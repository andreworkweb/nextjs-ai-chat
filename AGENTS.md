<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->


# Project Engineering Guidelines

## Stack
- Next.js App Router
- TypeScript
- React
- Tailwind CSS

## Architecture
- Keep server-side logic on the server
- Never expose API keys to the client
- Prefer simple solutions over abstractions
- Reuse existing components

## Coding
- Avoid unnecessary dependencies
- Use strict TypeScript types
- Handle loading, error and empty states
- Don't change unrelated files

## Workflow
1. Understand existing code first
2. Plan significant changes
3. Implement small, focused changes
4. Run type checks and tests
5. Review the diff before committing