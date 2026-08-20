# mini-react

React official-source-style pnpm workspace monorepo.
Minimal runnable path: createElement -> Fiber placeholder -> DOM createRoot.

## Packages

- packages/shared: shared constants, types, utilities (internal, not an app API)
- packages/scheduler: cooperative scheduling (setTimeout placeholder)
- packages/react: public API (createElement / jsx)
- packages/react-reconciler: host-agnostic Fiber reconciler
- packages/react-dom: DOM host config + createRoot / render

Dependency direction: shared <- scheduler / react <- react-reconciler <- react-dom.
Internal dependencies use workspace:*.

## Usage

Requires Node.js 18+ and pnpm 9. If `pnpm` is not on PATH, prefix commands with `corepack`.

```bash
corepack pnpm install
corepack pnpm dev
```

Open the local URL printed by Vite. The page should show Hello Mini React.

Typecheck:

```bash
corepack pnpm typecheck
```
