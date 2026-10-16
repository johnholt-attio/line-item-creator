# AGENTS.md

This file provides guidance to AI agents who are working on the code in this repository.

## Context

This repository contains an app built with the Attio App SDK. Apps are embedded directly in the
Attio CRM platform and can:

- Render UI with React using components from the `attio/client` package.
- Run server-side code and call external services from `.server.ts` files.
- Store API tokens using the connections system.
- Receive incoming requests from third-party services via webhooks.
- Subscribe to events e.g. `connection.added`.
- Manage forms with `useForm()`, and data fetching with `useAsyncCache()` and `useQuery()`.

SDK documentation lives at [docs.attio.com/sdk/overview](https://docs.attio.com/sdk/overview).

## Architecture

### File and folder structure

The folder-based layout under `src/app/` is the app entry-point convention. The CLI discovers
definitions by their paths and default exports; do not create or maintain a central registration
file.

| Path                                    | Description                                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/extensions/<id>/extension.tsx` | One default-exported [extension](https://docs.attio.com/sdk/extensions/overview) created with `Extensions.defineExtension(...)`                 |
| `src/app/extensions/<id>/*`             | Private components, GraphQL documents, and `.server.ts` helpers for that extension                                                              |
| `src/app/settings/schema.ts`            | The default-exported [workspace schema](https://docs.attio.com/sdk/settings/overview) created with `Settings.defineWorkspaceSchema(...)`        |
| `src/app/settings/page.tsx`             | Optional default-exported settings page created with `Settings.defineWorkspacePage(schema, () => ...)`                                          |
| `src/app/blocks/<id>/block.ts`          | A [workflow block](https://docs.attio.com/sdk/workflows/file-structure) definition; keep its handlers and configurator in the same block folder |
| `src/app/events/*.event.ts`             | Event handlers                                                                                                                                  |
| `src/app/webhooks/*.webhook.ts`         | Webhook handlers                                                                                                                                |
| `src/attio`                             | Code interacting with the [Attio API](https://docs.attio.com/rest-api/overview)                                                                 |
| `src/components`                        | Shared React components                                                                                                                         |
| `src/graphql`                           | Shared [Attio GraphQL](https://docs.attio.com/sdk/graphql/graphql) documents                                                                    |
| `src/utils`                             | Shared utility functions                                                                                                                        |

```tsx
import {Extensions} from "attio/client"

export default Extensions.defineExtension({
  id: "my-action",
  type: "record-action",
  label: "My action",
  onTrigger: async () => {},
})
```

```ts
import {Settings} from "attio"

export default Settings.defineWorkspaceSchema({
  apiKey: Settings.Schema.string(),
})
```

The old `src/app.ts`, `src/app.settings.ts`, and surface-registration folders are deprecated and
supported only for existing apps. Do not use them for new work. In an older app, run
[`attio migrate folder-structure`](https://docs.attio.com/sdk/guides/folder-structure-migration)
to adopt the folder convention as one migration.

## Environment

Code for the app may run either in a client-side or server-side context.

### Client-side code

Client-side code runs in the browser, inside a sandboxed custom JS runtime:

- You MUST only render components provided by the App SDK. No HTML tags (`<div>`), no custom
  styles or CSS.
- You MUST NOT read the DOM directly. Some browser APIs may not be available.
- You MUST NOT call `fetch` directly; make network calls via `.server.ts` functions instead.
- Files which render React components MUST use the `.tsx` extension.
- A settings page MAY render any `attio/client` component except `useForm`, `Button`,
  `EmptyState` and `LoadingState`. Use the form, inputs and `Button` returned by
  `Settings.useForm(schema)` instead.

### Server-side code

Server-side code runs in files ending in `.server.ts`, `.webhook.ts`, or `.event.ts`, plus
anything those files import. It runs in a custom JS runtime, not Node.js: many Node.js APIs are
supported, some are not, so factor this into your choice of packages.

### Environment variables

Server-side code can read environment variables via `process.env` (typed
`Record<string, string | undefined>`). Only `process.env` is supported.

IMPORTANT: `process` does NOT exist in client-side code. TypeScript cannot scope the global
`process` declaration to server files, so client-side usage type-checks but throws a
ReferenceError at runtime. You MUST only access `process.env` in server-side code.

- In development, define variables in a `.env` file in the project root, with optional overrides
  in `.env.local` (which wins on conflict). `attio dev` uploads them automatically.
- In production, variables are managed as app environment variables in Attio.
- Keys MUST match `^[A-Z][A-Z0-9_]*$`. The `ATTIO_` and `__ATTIO` prefixes are reserved.
- Reading a variable that is not set returns `undefined` at runtime and logs a warning.
- You MUST NOT commit `.env` or `.env.local`. They may contain secrets and are gitignored by
  default.

## Imports

Attio provides three packages:

1. `attio/client` - for client-side imports
2. `attio/server` - for server-side imports
3. `attio` - for shared/environment-agnostic imports

IMPORTANT: Before importing from these packages, confirm the import is correct against existing
examples in the codebase, the TypeScript type definitions and JSDoc, or the
[SDK documentation](https://docs.attio.com/sdk/overview). Do not guess.

## Coding guidelines

- You SHOULD use Zod to validate data from public APIs, including only the properties you
  explicitly need.
- You SHOULD use try/catch around calls to `.json()`.
- You SHOULD use `console.error` to capture information about unexpected errors.
- You MUST NOT log sensitive information such as email addresses or passwords.
- You MUST handle API errors gracefully. Do not throw from a React component; return a clear
  fallback UI instead.
- You SHOULD prefer named arguments over positional arguments when using 3 or more arguments.
- You MUST NOT use `any`. Fix type errors properly; `any` is a likely source of bugs.

## Validation

You MUST validate all your changes:

- Validate types: `npm run build`
- Validate formatting: `npm run format:check`
- Run and fix lint rules: `npm run lint:fix`
