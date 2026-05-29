# Contributing to FreeLLM

Thanks for wanting to contribute. This guide will get you from zero to your first PR.

## Table of Contents

- [Quick Start](#quick-start)
- [Before You Start](#before-you-start)
- [Project Structure](#project-structure)
- [What to Contribute](#what-to-contribute)
- [Development Guidelines](#development-guidelines)
- [House Rules](#house-rules)
- [Submitting a PR](#submitting-a-pr)
- [First Time Contributing?](#first-time-contributing-to-open-source)

## Quick Start

```bash
git clone https://github.com/Devansh-365/freellm.git
cd freellm
pnpm install
cp .env.example .env   # add at least one provider API key
pnpm dev
```

API server runs on `http://localhost:3000`. Dashboard on `http://localhost:5173`. Website on `http://localhost:4321` (run `cd apps/web && pnpm dev` separately).

Smoke test the gateway:

```bash
./scripts/test-gateway.sh
```

All 18 tests should pass.

## Before You Start

- Read the [Code of Conduct](CODE_OF_CONDUCT.md)
- Check [existing issues](https://github.com/Devansh-365/freellm/issues) to avoid duplicates
- For new features, **open an issue first** to discuss the approach before writing code
- For bug fixes and small improvements, feel free to go straight to a PR

## Project Structure

```
packages/
  api-server/              Express 5 + TypeScript gateway
    src/
      gateway/
        config.ts            Constants (meta-models, priorities, defaults)
        router.ts            Failover loop with round-robin/random
        registry.ts          Provider lifecycle management
        circuit-breaker.ts   Three-state health tracking
        rate-limiter.ts      Sliding-window + cooldown
        usage-tracker.ts     Rolling 24h token counts
        cache.ts             In-memory LRU response cache
        schemas.ts           Zod validation schemas
        providers/           One adapter per provider (groq, gemini, etc.)
      middleware/
        auth.ts              API key auth (timing-safe)
        admin-auth.ts        Admin-only route protection
        rate-limit.ts        Per-client IP rate limiting
        error-handler.ts     Centralized error formatting
        validate.ts          Zod validation middleware
      routes/v1/             OpenAI-compatible HTTP handlers

  dashboard/               React 18 + Vite + Tailwind dashboard SPA
    src/
      components/            Focused, single-responsibility UI components
      pages/                 Dashboard, Models, Quickstart

  website/                 Astro Starlight marketing site + docs
    src/
      pages/index.astro      Custom landing page
      content/docs/          Markdown/MDX documentation
      components/            Astro components (kebab-case)
      styles/                theme.css + landing.css

lib/
  api-spec/                OpenAPI 3.1 spec (source of truth)
  api-client-react/        Auto-generated React Query hooks via Orval

scripts/
  test-gateway.sh          18-test end-to-end smoke test suite
```

## What to Contribute

### High Impact

**New providers.** This is the single most valuable contribution. Every new free-tier LLM provider unlocks more capacity for all users.

How to add one:

1. Create `apps/gateway/src/providers/your-provider.ts` extending `BaseProvider`
2. Set `id`, `name`, `baseUrl`, and a `models` array with the prefix `your-provider/`
3. Implement `protected getApiKeys(): string[]` reading from `process.env`
4. Override `complete()` if the provider needs a non-standard request shape (see `ollama.ts`)
5. Register the provider in `gateway/registry.ts`
6. Add the provider to `FAST_PRIORITY` and `SMART_PRIORITY` in `gateway/config.ts`
7. Add a default model in `DEFAULT_MODELS` in `gateway/config.ts`
8. Add a per-key rate-limit config in `gateway/rate-limiter.ts` `PROVIDER_WINDOW_CONFIGS`
9. Update `.env.example` with the new env var (and document multi-key support)
10. Update the README Providers table, the website provider showcase, and the docs
11. Submit a PR

**Provider template:**

```typescript
// apps/gateway/src/providers/your-provider.ts
import { BaseProvider, parseApiKeys } from "./base.js";
import type { ModelObject } from "../types.js";

export class YourProvider extends BaseProvider {
  readonly id = "your-provider";
  readonly name = "Your Provider";
  readonly baseUrl = "https://api.your-provider.com/v1";

  readonly models: ModelObject[] = [
    {
      id: "your-provider/some-model",
      object: "model",
      created: 1700000000,
      owned_by: "your-provider",
      provider: "your-provider",
    },
  ];

  protected getApiKeys(): string[] {
    return parseApiKeys(process.env["YOUR_PROVIDER_API_KEY"]);
  }
}
```

### Also Welcome

- Bug fixes (especially in the failover loop and cache invalidation)
- Performance improvements to the routing path
- Better error messages
- Accessibility improvements to the dashboard
- More test coverage in `scripts/test-gateway.sh`
- Documentation improvements
- Website polish

### Not Looking For

- Features that require server-side state beyond what's already in-memory (we run on free tiers, persistence is opt-in)
- Native dependencies (`better-sqlite3`, `node-canvas`, etc.) — they break Railway/Render free-tier deploys
- Authentication/SSO/RBAC — Portkey owns that space, FreeLLM stays simple
- Paid-tier provider routing — OpenRouter owns that space
- Anything that prevents the gateway from starting on a fresh `pnpm install` with no env vars set

## Development Guidelines

### Code Style

- TypeScript strict mode. `pnpm typecheck` must pass with zero errors in every package
- No emojis as UI iconography (use SVG icons from Lucide or Phosphor)
- No em dashes in copy or comments (use `--` or sentence rewrites)
- Prefer composition over abstraction for one-off logic
- Match the existing patterns — when in doubt, mimic the closest similar file

### Commits

- Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `security:`
- Keep commits focused on a single change
- Write commit messages that explain why, not just what
- **No co-author lines** in commits — just the user as the author

### Testing Your Changes

```bash
# Type check (run in each package)
cd apps/gateway && pnpm typecheck
cd packages/dashboard && pnpm typecheck

# Build the API server
cd apps/gateway && pnpm build

# Smoke test the running gateway
./scripts/test-gateway.sh
```

### Key Architecture Rules

1. **In-memory by default.** Every observability piece (request log, rate limiter, circuit breaker, usage tracker, cache) is in-memory. Don't add database-backed storage unless there's a specific reason.
2. **No native modules.** Anything that needs `node-gyp` will break Railway's slim image build.
3. **Provider isolation.** Provider failures must be contained by the circuit breaker. One bad provider should never bring down the gateway.
4. **Concurrency safety.** When attributing a response to a key (multi-key rotation) or to a provider (failover), use the WeakMap pattern in `BaseProvider` to avoid race conditions between concurrent requests.
5. **Streaming bypasses caching.** The OpenAI SSE protocol is not compatible with our cache abstraction. Never add streaming support to the cache.
6. **Errors are not cached.** Only successful 2xx responses go into the response cache.
7. **Errors don't trip circuit breakers indiscriminately.** 4xx (`400`/`401`/`403`/`404`) are non-retriable client errors and surface immediately. 5xx and network failures trip the breaker.

## House Rules

These keep the project healthy and reviews fast.

### Before You Code

- **Check for duplicates.** Search open issues and PRs before starting work.
- **Get approval for features.** Open an issue, describe the problem, and wait for a maintainer response before building.
- **Claim the issue.** Comment on an issue to let others know you're working on it.

### Writing Your PR

- **Keep PRs small.** Under 400 lines changed and under 10 files modified is ideal. Split large changes into stacked PRs.
- **Think like a reviewer.** What would someone unfamiliar with this change need to know?
- **Link the issue.** Use `Closes #123` in the PR description so it auto-closes when merged.
- **Show your work.** For UI changes, include a screenshot or short video.
- **Describe what you tested.** Which providers, which env vars, which edge cases.

### Code Quality

- No `console.log` left in committed code (use the `pino` logger)
- No commented-out code blocks
- No `any` types unless absolutely unavoidable (and commented why)
- Prefer composition over abstraction for one-off logic

## Submitting a PR

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Verify: `pnpm typecheck` in each package + `./scripts/test-gateway.sh`
4. Open a PR with a clear description of what and why
5. Fill out the PR template checklist
6. Wait for review. We aim to respond within a few days.

## First Time Contributing to Open Source?

Look for issues labeled [`good first issue`](https://github.com/Devansh-365/freellm/labels/good%20first%20issue). These are scoped, well-defined tasks that don't require deep knowledge of the codebase.

If you're stuck, open a draft PR and ask for help. We'd rather help you finish than see you give up.

## Questions?

Use [GitHub Discussions](https://github.com/Devansh-365/freellm/discussions) for questions about the codebase or contribution process. Issues are for bugs and feature requests only.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
