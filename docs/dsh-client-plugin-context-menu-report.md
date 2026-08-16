# DSH client plugin: right-click "Copy session id" on sidebar rows — API report

All paths below are rooted at the DSH checkout:
`/home/qingqi/.nvm/versions/node/v26.7.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
(abbreviated here as `$DSH/`).

---

## 1. `shell.overlay` slot: props injected & component signature

### Slot declaration
Declared by the layout plugin's `AppFrame` in
`$DSH/dsh-client-ui-layout/lib/types/client/index.d.ts:77-80`:

```ts
'shell.overlay': {
    kind: 'list';
    scope: 'root';
};
```

- **kind: `'list'`** → additive, each new `id` sits beside the shipped entries (never shadows).
- **scope: `'root'`** → global, always mounted (not session-bound).
- **No `owner`** → the frame renders it with `renderSlot("shell.overlay", {})`
  (`$DSH/dsh-client-ui-layout/lib/client.js:237`). The owner share is empty.

### What props the component receives
The framework composes props as `ComposedProps<K, ...>` defined in
`$DSH/dsh-client-ui-slots/lib/types/index.d.ts` (`ComposedProps` declaration). For a `root`-scope list slot with no `owner`, no `store`, no `chain`, and (optionally) one `locale`:

```ts
type ComposedProps<'shell.overlay', string, never, never, object, never, N>
  = PropsRuntime<'shell.overlay'>      // OwnerOf={} ∩ KeyPropsOf=object ∩ InjectFace∩GlobalStandardProps
  & PropsRenderSlots<'shell.overlay'>  // renderSlot/renderSlotChain — only present if you DECLARE children
  & PropsStore<never>                   // object (no store declared)
  & InjectFace<object>                  // object (no inject declared)
  & MatchedShare<...>                   // object (not chain)
  & PropsLocale<N>                      // { t } ONLY if you declare `locale: N`
```

- `PropsRuntime` (`…/index.ts`): `ScopeOf<'shell.overlay'>` is `'root'`, so **neither** `SessionStandardProps` nor `SessionMaybeStandardProps` apply. The only framework members come from **`GlobalStandardProps`**, declared and typed in
  `$DSH/dsh-client-runtime/lib/types/client/index.d.ts`:

```ts
interface GlobalStandardProps {
    useSessions:   SnapshotSelectorHook<SessionListState>;
    useWorkspaces: SnapshotSelectorHook<import('./workspaces/service.ts').WorkspaceListState>;
}
```

So a `shell.overlay` entry component effectively receives (when it declares `locale`):

```ts
interface OverlayProps {
    useSessions:   SnapshotSelectorHook<SessionListState>;
    useWorkspaces: SnapshotSelectorHook<WorkspaceListState>;
    t: TranslateNS<YourNamespace>;   // present iff you set `locale: NS` in register options
    // plus renderSlot/renderSlotChain IF you declare children (you don't)
}
```

**There is no `sessionId` / `useSession` / `useProjection` on a `root`-scope slot.**

### Exact component type the registrant provides
The render function is a **plain React function component** typed as
`SlotComponent<P> = (props: P) => ReactNode` (`$DSH/dsh-client-ui-slots/lib/types/index.d.ts`).
`ctx.slots.register`'s second argument is `C & SlotComponent<ComposedProps<K, …>>`. So:

```ts
function MyOverlay(props: OverlayProps): React.JSX.Element { ... }
```

It **does** receive props (the composed intersection above). (Note: existing DSH overlay consumers always write it as a single-arg props function; e.g. `WorkspaceBrowser({ useStore, useSessions, actions, renderSlot, … })` in
`$DSH/dsh-client-ui-workspace/lib/types/client/rows/Rows.d.ts` / `AppFrame`.)

### The mount layer
`AppFrame` renders `shell.overlay` inside
`<div class=overlayLayer data-shell-overlay …>` whose CSS is
`z-index:20; pointer-events:none; position:absolute; inset:0`
(`$DSH/dsh-client-ui-layout/lib/client.js`, class `overlayLayer`). So the layer never blocks the app; **your menu must re-enable `pointer-events:auto`** on the element that should be clickable.

---

## 2. Reading the full session list inside a client plugin / slot component

### `SessionId` type
Branded string, not a plain `string`:
- Defined in `$DSH/dsh-session/lib/types/types.d.ts:6` as `export type SessionId = Branded<'SessionId';` (`Branded` from `@deepseek-ai/dsh-brand`).
- Re-exported at `$DSH/dsh-client-runtime/lib/types/client/index.d.ts` (bottom): `export type { SessionId } from '@deepseek-ai/dsh-client-connection/client';` → which re-exports from `@deepseek-ai/dsh-session/types`.
- There is a runtime cast function `SessionId(id: string): SessionId` in the same file (compile-time-only cast; free at runtime).
- Use as `import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client';`

### `SessionSummary`, `SessionListState`
`$DSH/dsh-client-runtime/lib/types/client/sessions/service.d.ts`:

```ts
export interface SessionSummary {
    id: SessionId;
    title?: string;            // latest durable log-backed title (absent until projected)
    displayTitle: string;      // durable title, else project basename, else session id
    cwd?: string;
    agentPreset?: string;
    parentId?: SessionId;
    origin?: 'subagent';
    running: boolean;
    pendingInteraction?: PendingInteractionStatus;
    completed?: boolean;
    blank: boolean;
    updatedAt: number;
    projectionValues?: Readonly<Partial<SessionProjectionMap>>;
}

export interface SessionListState {
    ids: SessionId[];                                  // host-list order
    byId: Record<SessionId, SessionSummary>;           // every row
    current: SessionId | undefined;
    phase: SessionListPhase;                            // 'pending' | 'ready'
    subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>;
    jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>;
    currentAddress: SubagentAddress | undefined;
}
```
`SessionListPhase = 'pending' | 'ready'` (`…/sessions/manager.d.ts`).

### `ctx.sessions` (the `ISessions` service)
`$DSH/dsh-client-runtime/lib/types/client/contract/sessions.d.ts` and the module merge in
`$DSH/dsh-client-runtime/lib/types/client/index.d.ts` declare `ctx.sessions: ISessions`.

For reading sessions the useful members are:
```ts
ctx.sessions.list;                                  // ObservableSnapshot<SessionListState>
ctx.sessions.open(id: SessionId): void;
ctx.sessions.binding(id: SessionId): SessionBinding | undefined;  // { sessionId, session: SessionFace, ctx }
ctx.sessions.clear(): void;
```
`ObservableSnapshot<T>` = `{ getSnapshot(): T; subscribe(fn: () => void): () => void; }`
(`$DSH/dsh-client-runtime/lib/types/client/contract/store.d.ts`). `ctx.sessions.list` is the same feed backing `useSessions`.

### The `useSessions` hook (React path)
**`useSessions` is a framework standard prop — it is NOT an export of `@deepseek-ai/dsh-client-runtime/client`.** It is delivered bound into every global slot component via `GlobalStandardProps` (confirmed: the runtime's `client/index.d.ts` exports types but no `useSessions`; only `class SlotRegistry`, `defineStore`, etc.). Usage inside a slot component:

```ts
const summaries = props.useSessions((s: SessionListState) => s.byId);
const ids        = props.useSessions((s: SessionListState) => s.ids);
```
Real uses: `$DSH/dsh-client-ui-subagent/lib/client.js:348` (`useSessions((state) => state.subagentsByParent)`), `…:349` (`useSessions((state) => state.byId)`); `$DSH/dsh-client-ui-agent-preset/lib/client.js:192`.

### Non-React read
Use `ctx.sessions.list.getSnapshot()` / `ctx.sessions.list.subscribe(fn)` — exact pattern in `$DSH/dsh-client-ui-subagent/lib/client.js` apply body:
```ts
const sessions = ctx.sessions;
const { byId } = sessions.list.getSnapshot();
sessions.list.subscribe(listener);   // returns unsubscribe
```

---

## 3. `@deepseek-ai/dsh-client-ui-primitives` for Menu / toast / icons / copy

Barrel: `$DSH/dsh-client-ui-primitives/lib/types/index.d.ts` and `lib/index.js` (packaged export list on line 5855).

### (a) `Menu` — exact signature
`$DSH/dsh-client-ui-primitives/lib/types/Menu.d.ts`:

```ts
export interface MenuItem {
    id: string;
    label: ReactNode;
    disabled?: boolean;
    icon?: ReactNode;
    danger?: boolean;
    submenu?: readonly MenuItem[];
}
export type MenuEntry = MenuItem | MenuSeparator | MenuLabel;   // MenuSeparator {type:'separator',id}; MenuLabel{type:'label',id,text}

export declare function Menu({ open, anchor, items, selectedId, selectedIds,
    onSelect, onClose, align, side, portal, closeOnPointerLeave, dense, compact,
    getAnchorRect, footer, className }: {
    open: boolean;
    anchor: ReactNode;                       // the trigger element rendered in place
    items: readonly MenuEntry[];
    footer?: readonly MenuEntry[];
    selectedId?: string | undefined;
    selectedIds?: readonly string[] | undefined;
    onSelect: (id: string) => void;
    onClose: () => void;
    align?: 'start' | 'end';
    side?: 'bottom' | 'top' | 'right';
    portal?: boolean;                        // render list into document.body, fixed-positioned from anchor rect
    closeOnPointerLeave?: boolean;
    dense?: boolean;
    compact?: boolean;
    getAnchorRect?: () => DOMRect | null;    // portal mode: supply rect directly (doc says: use for effect-positioned proxies)
    className?: string;
}): React.JSX.Element;
```
For a **context menu at the cursor**, use `portal: true` + `getAnchorRect: () => rectAt(e.clientX, e.clientY)` — the doc explicitly targets `getAnchorRect` for "effect-positioned proxies" where measuring the wrapper races host layout. (This is exactly how the workspace row `Menu` is driven; it passes `anchor` a real row button.)

### (b) Toasts — **there is no `useToast` / no `ctx.toast` service**
- The only toast primitive is the presentational `Toast` component:
  `$DSH/dsh-client-ui-primitives/lib/types/Toast.d.ts`:
  ```ts
  export declare function Toast({ text, icon, anchor, onDone }: {
      text: string; icon?: ReactNode; anchor?: HTMLElement | null; onDone: () => void;
  }): React.ReactPortal;
  ```
  (`onDone` fires after fade; owner unmounts it.) There is **no toast manager** anywhere in the DSH client bundles — a grep for `useToast` / `ctx.toast` across all `dsh-client-*` `lib/client.js` returns nothing.
- Because you are already in the `shell.overlay` floating layer, the cleanest pattern is to render a row-local `Toast`/feedback **inside your overlay component** (e.g. a small "Copied" pill), or simply flip a `copied` flag on the Menu item label. You own the `onDone` unmount.

### (c) Icons — Copy
Export list `$DSH/dsh-client-ui-primitives/lib/types/icons/index.d.ts` (and barrel line 5855):
- `IconCopyOutline16` — present (line 45): `({ size, className }: IconProps) => React.JSX.Element`.
- `IconCheckOutline16` / `IconCheckOutline14` — for a "copied ✓" state.
- `IconProps = { size?: number | undefined; className?: string | undefined }`
  (`…/icons/props.d.ts`). `size` is transparent to these 16px glyphs.

Note: **`useCopyFeedback` is NOT exported** from the primitives barrel (it exists internally at `$DSH/dsh-client-ui-primitives/lib/index.js:3479` but is absent from both `index.d.ts` exports and the `index.js` export statement). Do not import it.

---

## 4. `ctx` access & the `inject` list for your plugin

Client plugins are cordis plugins; `ctx` is the client `Context`. The service names you need, with the exact plugin declarations observed in the shipped bundles:

- **`slots`** (`ctx.slots: SlotRegistry`) — to `register`/`inject`. Declared in `$DSH/dsh-client-runtime/lib/types/client/index.d.ts` module merge, and used by every UI plugin.
- **`sessions`** (`ctx.sessions: ISessions`) — to read the list / open. Declared in the same merge.
- **`locale`** (`ctx.locale`) — to register dictionary namespaces. Used as `ctx.locale.register(NS, { zh, en })` inside `ctx.effect(...)`.
- **`workspaces`** — needed only if you touch workspace rows.
- **`connection`** / **`invoke`** — **not needed** for a copy-id-only menu. `connection` is a runtime bootstrap service (see runtime's own `inject = ["connection","typert","remote","remote.commands"]`, `$DSH/dsh-client-runtime/lib/client.js:10462`). You may require it if you later perform a host RPC, but for copying a locally-known `SessionId` you do not. There is no generic `invoke` service; host RPC goes through `useInvoke`-wrapped closures over `ctx.sessions`/`ctx` (e.g. `session.rename`, `ctx.workspaces.*`).

Recommended `inject` for this plugin:
```ts
export const inject = ["slots", "sessions", "locale"];
```
Patterns (verbatim from shipped bundles):
- `$DSH/dsh-client-ui-subagent/lib/client.js:628`: `const inject = ["inputTriggers","sessions","slots","locale"];`
- `$DSH/dsh-client-ui-workspace/lib/client.js`: `const inject = ["slots","sessions","workspaces","locale"];`
- Every client bundle ends with `exports.apply = apply; exports.inject = inject;` and wraps in
  `window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports; } })`.

**Note on `ctx.effect`/fiber lifecycle:** register disposable resources (slot entries, event listeners, locale) through `ctx.effect(() => disposer(), "label")` or close them in an effect clean-up, so unload/reload cleans up.

---

## 5. Exact `ctx.slots.register(...)` shape for a list slot — minimal complete plugin

`ctx.slots.register` is `SlotCore['register']` with two overloads
(`$DSH/dsh-client-ui-slots/lib/types/index.d.ts`, register overload docs). The list-slot options require at least `{ name, id }` (missing `id` throws) and allow `order`, `label`, `priority`, `locale`, `store`, `inject`.

Real registration of a `list` slot (the strongest analog to `shell.overlay`), from `$DSH/dsh-client-ui-subagent/lib/client.js`:

```js
ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
    name: "conversation.session.header.actions",
    id: "subagent-catalog",
    order: 10,
    locale: NS,
    inject: catalogActions
}, SubagentCatalogAction));
```
`ctx.slots.inject(key, factory)` batches registration against that slot's declaration lifetime and disposes the entry when your plugin unloads (`$DSH/dsh-client-runtime/lib/types/client/slots.d.ts`, `SlotRegistry.inject`).

A complete, minimal-but-realistic plugin (adapted to all the real signatures):

```ts
// src/client/index.ts  (build → lib/client.js, ModuleLoader.wrapped in dist)
import { Context } from '@deepseek-ai/cordis';
import {
    defineStore, // unused here, kept to show availability
} from '@deepseek-ai/dsh-client-runtime/client';
import { Menu, Toast, IconCopyOutline16, IconCheckOutline16, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { SessionListState } from '@deepseek-ai/dsh-client-runtime/client';

export const inject = ["slots", "sessions", "locale"];

const NS = "session-context-menu";
const dictionaries = {
    en: { "menu.copyId": "Copy session id", "toast.copied": "Copied" },
    zh: { "menu.copyId": "复制会话 ID", "toast.copied": "已复制" },
};

interface CopyMenuProps {
    useSessions: (sel: (s: SessionListState) => unknown) => unknown;
    t: (key: string, params?: Record<string, unknown>) => string;
}

function CopySessionMenu({ useSessions, t }: CopyMenuProps) {
    // local state: cursor pos, target session id — see §sample below
}

export function apply(ctx: Context): void {
    ctx.effect(() => ctx.locale.register(NS, dictionaries), "session-context-menu: dictionary");
    ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "session-context-menu",
        order: 100,
        locale: NS,
    }, CopySessionMenu));
}
```

The register call's `component` arg type is `SlotComponent<ComposedProps<'shell.overlay', string, never, never, object, never, NS>>` — i.e. a function receiving `{ useSessions, useWorkspaces, t }`.

---

## 6. How `useSessions` works (bound selector) & getting current SessionSummary rows

- **Binding machinery:** `bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T>`
  (`$DSH/dsh-client-web-react/lib/types/bind.d.ts`). It captures `subscribe`/`getSnapshot` once into stable closures and returns a selector hook over the source. The runtime's global kit is bound by the renderer from `ctx.sessions.list` into the `useSessions` standard prop (`SlotRendererHost.sessions.list`, `$DSH/dsh-client-ui-slots/lib/types/renderer.d.ts`).
- **SnapshotSelectorHook** = `<S>(sel: (s: T) => S, eq?: (a,b)=>boolean) => S`
  (`$DSH/dsh-client-ui-slots/lib/types/store.d.ts`).
- **What it returns:** whatever your selector returns — for the whole list state select `(s) => s` (returns `SessionListState` = `{ ids, byId, current, phase, subagentsByParent, jobsBySession, currentAddress }`), or slice it:
  ```ts
  const byId   = useSessions((s) => s.byId);       // Record<SessionId, SessionSummary>
  const ids    = useSessions((s) => s.ids);        // SessionId[]
  const cur    = useSessions((s) => s.current);    // SessionId | undefined
  ```
- **Non-React:** `ctx.sessions.list.getSnapshot()` returns the same `SessionListState`; `ctx.sessions.list.subscribe(fn)` for updates (see §2).
- **The shaped answer you asked for (`{ ids, byId, current, phase … }`) is exactly `SessionListState`** — confirmed (plus `subagentsByParent`, `jobsBySession`, `currentAddress`).

To get SessionSummary **rows**:
- React: `useSessions((s) => s.ids.map((id) => s.byId[id]))` (or `Object.values(s.byId)`).
- Non-React: `Object.values(ctx.sessions.list.getSnapshot().byId)`.

---

## 7. Clipboard & copy feedback

- Prefer the exported primitive `writeClipboard(text: string): Promise<boolean>` from
  `@deepseek-ai/dsh-client-ui-primitives`. Implementation (`$DSH/dsh-client-ui-primitives/lib/index.js:1755`) uses `navigator.clipboard.writeText` first, falls back to a hidden-textarea `document.execCommand('copy')` on hosts lacking the async API, and returns a boolean acceptance. So: **use `writeClipboard`, not bare `navigator.clipboard`** (you get the insecure-context fallback for free).
- `navigator.clipboard.writeText` is what DSH itself uses underneath — using it directly also works but loses the fallback.
- **Toast helper:** none exists for "copied" (§3b). Render your own feedback in the overlay (a `Toast`, or swap the Menu item icon to `IconCheckOutline16` and label to "Copied"). `useCopyFeedback` exists internally but is **not exported** — replicate its trivial pattern if you want the flag:
  ```ts
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
      if (await writeClipboard(id)) { setCopied(true); setTimeout(() => setCopied(false), 1000); }
  };
  ```
- Real consumer pattern: `$DSH/dsh-client-ui-conversation/lib/client.js` calls `writeClipboard(...)` then `.then((ok) => {…})`.

---

## 8. `__ModuleLoader__.load` browser-bundle wrapper

Exact wrapper format (top of `$DSH/dsh-client-ui-workspace/lib/client.js`, and every shipped `client.js`):

```js
window.__ModuleLoader__.load({
    id: "@deepseek-ai/dsh-client-ui-workspace",   // your package name
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        // requires resolve by module id (see below)
        const react_jsx_runtime = require("react/jsx-runtime");
        const react = require("react");
        // ... your code; exports.apply = apply; exports.inject = inject;
        return module.exports;
    }
});
```

- `require` resolves **module ids** (package resolution the loader understands): `"@deepseek-ai/dsh-client-runtime/client"`, `"react"`, `"react/jsx-runtime"`, `"@deepseek-ai/dsh-client-ui-primitives"`, `"react/jsx-dev-runtime"`, etc.
- **`react` and `react/jsx-runtime` both work** — this is exactly how the shipped bundles do it (see the workspace/client.js header: `require("@deepseek-ai/dsh-client-runtime/client")`, `require("react/jsx-runtime")`, `require("react")`, `require("@deepseek-ai/dsh-client-ui-primitives")`).
- The factory must populate `module.exports` and assign `exports.apply`/`exports.inject`. The bundle is CommonJS-style inside the factory; use `Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })` to mirror the shipped shape (helps interop with the loader's ESM-style consumers).
- Build your source to this single file yourself (Rollup/tsup externals: `react`, `react/jsx-runtime`, `@deepseek-ai/*`).

---

## 9. Existing context-menu / session-action extension points

I grepped every `dsh-client-*/lib/client.js` for `onContextMenu` / `contextmenu` and searched all `dsh-client-ui-slots` contract declarations for any per-session row action slot. Findings:

- **Only `$DSH/dsh-client-ui-trajectory/lib/client.js` uses `onContextMenu`** (a node-link canvas handler, unrelated to sidebar rows).
- **There is NO `contextmenu` / context-menu / per-session row action slot.** The workspace's session rows each render a hard-coded row actions `Menu` (`rename`/`fork`/`archive`) — see `SessionNodeItem` in `$DSH/dsh-client-ui-workspace/lib/client.js` (~line 692) and `Rows.d.ts`. That menu is private to the workspace plugin (local React `useState` + literal items); **it is not a slot and not injectable**.
- The only slots the workspace browser declares are `sidebar.workspaces` (whole left region) and `sidebar.workspaces.directoryFlow` (a `single` directory-picking hole — irrelevant to row actions). `$DSH/dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts`.

**Conclusion:** there is no cleaner per-session extension point today. The document-level `contextmenu` listener + `shell.overlay` menu is the **reasonable, supported** approach (and the layout docs for `shell.overlay` explicitly call it "This is the additive seat for a frame-wide surface of your own"). Register into `shell.overlay` with a unique `id`.

### Sheet-anchor for the "resolve session id from the row" step
The rendered session row is `<div role="treeitem">` (`$DSH/dsh-client-ui-workspace/lib/client.js:704-720`; also `SearchResultItem` and `ProjectRowItem` use `role:"treeitem"`). **The row carries NO `data-session-id` attribute** — the `node.id` only reaches the DOM as `e.dataTransfer.setData("text/plain", node.id)` on `dragstart` (`…/client.js` in the `onDragStart` handler). So a pure-DOM right-click handler cannot read the id off a `dataset` attribute.

Recommended resolution in your overlay component:
1. On `contextmenu`, call `event.preventDefault()`; walk `closest('[role="treeitem"]')` from `event.target`.
2. Read the row's visible title text (the row contains a title span; also compare against blank-row state) and look it up in `useSessions((s)=>s.byId)` by matching `displayTitle` computed exactly like the workspace: `displayTitle = node.blank ? t("session.new") : node.title` (`$DSH/dsh-client-ui-workspace/lib/client.js:389`, `displayTitle(node, t)`).
3. Because `displayTitle` may not be unique (titles can collide and blank rows all say "New Session"), prefer disambiguating by matching the row's trailing relative-time/`updatedAt` and current order in `ids`, or fall back to showing the first/rejecting ambiguous matches. If you need an exact, unambiguous id, the durable signal is only available on drag — a limitation of the current workspace DOM.

If exactness matters and you can tolerate a small change, note in your issue/PR that adding `data-session-id={node.id}` to `SessionNodeItem`'s `div` (and the `SearchResultItem` button) would make the mapping trivial — but that requires a workspace-plugin patch rather than a pure overlay plugin.

---

## Complete sample plugin (React + cordis) to adapt

Key facts baked in: root-scope overlay → only `useSessions`/`useWorkspaces`/`t` props; `portal`+`getAnchorRect` Menu for cursor anchoring; `writeClipboard`; `ctx.effect` + `ctx.slots.inject` for lifecycle.

```tsx
// client/src/index.tsx
import type { ReactNode } from 'react';
import {
    Menu, MenuEntry, Toast,
    IconCopyOutline16, IconCheckOutline16,
    writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';

export const inject = ['slots', 'sessions', 'locale'];

const NS = 'session-context-menu';
const dict = {
    en: { 'menu.copyId': 'Copy session id', 'toast.copied': 'Copied', 'session.new': 'New Session' },
    zh: { 'menu.copyId': '复制会话 ID', 'toast.copied': '已复制', 'session.new': '新会话' },
};

// Props a shell.overlay (root scope) entry receives.
interface CopyProps {
    useSessions: (sel: (s: SessionListState) => any) => any;
    t: (key: string, params?: Record<string, unknown>) => string;
}

function CopySessionMenu({ useSessions, t }: CopyProps) {
    const byId = useSessions((s) => s.byId) as Record<SessionId, { id: SessionId; blank: boolean; title?: string; displayTitle: string }>;
    const [rect, setRect] = React.useState<{ x: number; y: number } | null>(null);
    const [id, setId] = React.useState<SessionId | null>(null);
    const [copied, setCopied] = React.useState(false);
    const [toast, setToast] = React.useState(false);

    React.useEffect(() => {
        function onCtx(e: MouseEvent) {
            // right-click over a session row
            const row = (e.target as Element).closest('[role="treeitem"]');
            if (!row) { setRect(null); setId(null); return; }
            e.preventDefault();
            // resolve id via the row title text, exactly like the workspace displayTitle
            const text = (row.querySelector('[class$="_title"], span') as HTMLElement | null)?.textContent?.trim() ?? '';
            const found = Object.values(byId).find((s) =>
                s.blank ? text === t('session.new') : s.displayTitle === text,
            );
            if (found) { setRect({ x: e.clientX, y: e.clientY }); setId(found.id); setCopied(false); }
            else { setRect(null); setId(null); }
        }
        document.addEventListener('contextmenu', onCtx);
        return () => document.removeEventListener('contextmenu', onCtx);
    }, [byId, t]);

    const onSelect = async () => {
        if (id === null) return;
        const ok = await writeClipboard(String(id));
        setCopied(ok);
        if (ok) { setToast(true); setTimeout(() => setToast(false), 1500); }
        window.setTimeout(() => { setRect(null); setId(null); }, 150);
    };

    const items: MenuEntry[] = [{
        id: 'copy', label: copied ? t('toast.copied') : t('menu.copyId'),
        icon: copied ? <IconCheckOutline16 size={16} /> : <IconCopyOutline16 size={16} />,
    }];

    return (
        <div style={{ pointerEvents: 'none' }}> {/* overlay layer is click-through; re-enable on children */}
            {rect && id !== null && (
                <div style={{ pointerEvents: 'auto', position: 'fixed', left: rect.x, top: rect.y, zIndex: 30 }}>
                    <Menu
                        open
                        portal
                        getAnchorRect={() => ({ left: rect.x, top: rect.y, x: rect.x, y: rect.y, width: 0, height: 0, right: rect.x, bottom: rect.y, toJSON: () => ({}) })}
                        items={items}
                        onSelect={() => { void onSelect(); }}
                        onClose={() => { setRect(null); setId(null); }}
                        anchor={<span style={{ display: 'none' }} />}
                    />
                </div>
            )}
            {toast && <Toast text={t('toast.copied')} onDone={() => setToast(false)} />}
        </div>
    );
}

export function apply(ctx: ClientContext): void {
    ctx.effect(() => ctx.locale.register(NS, dict), 'session-context-menu: dictionaries');
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-context-menu',
        order: 100,
        locale: NS,
    }, CopySessionMenu));
}
```

---

## Quick reference table

| Question | Answer |
|---|---|
| `shell.overlay` props | root scope → `useSessions`, `useWorkspaces`, `t` (if `locale`). No `sessionId`. (`…/runtime/client/index.d.ts` `GlobalStandardProps`) |
| Component signature | `(props) => ReactNode`, props = `ComposedProps<'shell.overlay', …>` |
| Full session list | `props.useSessions((s)=>s.byId)` — React; `ctx.sessions.list.getSnapshot()` — non-React |
| `SessionId` | `Branded<'SessionId'>` (string-castable via free fn `SessionId(id)`) |
| Menu | `Menu({ open, anchor, items, onSelect, onClose, portal, getAnchorRect, … })` |
| Toast | **component only** `Toast({ text, icon?, anchor?, onDone })`; **no `useToast`/service** |
| Icons | `IconCopyOutline16`, `IconCheckOutline16` etc. (`IconProps={size?,className?}`) |
| `inject` services | `['slots','sessions','locale']` (add `workspaces` if touching workspace rows) |
| register shape | `ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name:'shell.overlay', id, order, locale }, Cmp))` |
| `useSessions` | `SnapshotSelectorHook<SessionListState>`; state = `{ids,byId,current,phase,…}`; **not** a package export — it's a standard prop |
| Clipboard | `writeClipboard(text): Promise<boolean>` (uses `navigator.clipboard.writeText` + fallback) |
| Wrapper | `window.__ModuleLoader__.load({ id, factory:(require)=>{…; exports.apply=apply; exports.inject=inject; return module.exports; } })`; `react`/`react/jsx-runtime` work |
| Cleaner extension point? | **None.** No `contextmenu`/session row action slot exists (only ui-trajectory's canvas `onContextMenu`); workspace row `Menu` is private. `shell.overlay` + document listener is the supported approach. |
| Row→id caveat | Session rows (`div[role="treeitem"]`) carry **no `data-session-id`**; id only on `dragstart` dataTransfer. Resolve via `displayTitle` matching (`blank → t('session.new')`, else `node.title`), with the ambiguity caveat noted. |
