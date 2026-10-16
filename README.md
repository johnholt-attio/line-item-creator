# Line Item Creator

## `line-item-creator` Attio app

### Build

```bash
npm install
```

### Dev Mode

```bash
npm run dev
```

### App structure

This app uses the folder-based App SDK convention. Extensions are discovered from
`src/app/extensions/<id>/extension.tsx`, and workspace settings are discovered from
`src/app/settings/`. There is no central `src/app.ts` registration file.

- `src/app/extensions/add-line-item/`: the **Add line item** record action on Deals, its setup
  check and automatic setup, and the server function that creates line items.
- `src/app/settings/`: the settings page (Products mapping and Deal value sync).
- `src/app/webhooks/line-items-sync.webhook.ts`: keeps Deal value in step with line items.
- `src/attio/`: Attio REST API helpers and the Deal value sync logic.

### Shipping a version

```bash
npm run attio version create
```

Workspaces that installed the app through a private invite move to the new version
automatically.

### Linting and formatting

```bash
npm run lint
npm run format
```
