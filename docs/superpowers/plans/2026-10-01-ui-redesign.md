# UI Redesign (Direction A "차분한 연구 도구") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc web UI with one coherent, token-driven design system (direction A) and apply it to every screen, so the portal looks deliberate and stays fast to read for researchers.

**Architecture:** Tokens live as CSS variables in `apps/web/src/app/globals.css` (Tailwind v4 `@theme`), light/dark via `next-themes` class strategy. `packages/ui` is rebuilt on Base UI primitives + cva variants, keeping its existing export names where possible so screens migrate incrementally. A new app shell (sidebar + top bar + ⌘K) wraps all platform routes; then screen groups are restyled in parallel worktrees, each proven by Playwright screenshots.

**Tech Stack:** Next.js 15, React 19, Tailwind CSS v4, Base UI (`@base-ui-components/react`), cmdk, Sonner, cva, clsx, tailwind-merge, next-themes, react-virtuoso, recharts, react-day-picker, lucide-react, Pretendard (npm `pretendard`), JetBrains Mono (`@fontsource-variable/jetbrains-mono`), Vitest + Testing Library, Playwright (+ axe).

**Spec:** `docs/superpowers/specs/2026-10-01-ui-design-system.md` (binding: tokens §2, shell §3, components §4, templates §5, per-screen notes §6, a11y §7, QA §8).

## Global Constraints

- Branch base `feat/wave15`. Work in worktrees as listed under Parallelization; one commit per task (fix rounds may add commits). Commit trailer: blank line + your harness Co-Authored-By line.
- Run `scripts/check_no_public_ip.sh` before every commit; the repo is PUBLIC (never write the server IP).
- Never touch docker/compose or live containers. Screenshots and e2e use a locally started server on **port 3100** (existing `apps/web/playwright.config.ts` webServer).
- No secure-context-only browser APIs (`crypto.randomUUID`, `crypto.subtle`, `navigator.clipboard` without fallback). Use `shared/lib/random-id.ts` and `@nais/ui` `copyText`.
- Mock mode (`NEXT_PUBLIC_API_MOCKING=enabled`) keeps working; real-mode build (`NEXT_PUBLIC_API_MOCKING=disabled pnpm --dir apps/web build`) must succeed and must not bundle mock code.
- Green before every commit: `corepack pnpm --dir apps/web lint && corepack pnpm --dir apps/web typecheck && corepack pnpm --dir apps/web test`, `corepack pnpm --dir packages/ui typecheck && corepack pnpm --dir packages/ui test`; screen tasks also run `corepack pnpm --dir apps/web e2e` (both projects incl. `chromium-insecure-origin`).
- **Only tokens**: no raw hex/rgb in components (tokens file excepted), spacing on the 4px scale, radii only `rounded-sm|md|lg` mapped to 6/10/14px. The anti-pattern table in spec §1 is a review blocker.
- Accessible names used by existing tests may change only together with the tests in the same commit; e2e axe checks stay at 0 violations.
- Motion: only `transform`/`opacity`; no `transition-all`; durations from tokens; no animation on ⌘K open/close, tab switches or keyboard list navigation; `prefers-reduced-motion` handled.
- Fonts are self-hosted from npm (no Google Fonts / external CDN at runtime).

## Review Focus

1. **Regression in permission-driven UI** — gated preview notice, AccessCta states, steward-only DRAFT visibility, PLATFORM_ADMIN-only transfer card must look different but behave identically (existing tests must still pass unchanged in intent).
2. **Dark mode contrast** — muted text and borders on `--bg-subtle`/`--bg-panel` in dark; badges' 3/11 step pairs. Screenshot every screen in dark.
3. **390px layout** — sidebar becomes a sheet, right rails stack under content, tables scroll inside their container (never the page), inputs are 16px.
4. **Non-secure origin** — ⌘K, copy buttons, theme persistence (localStorage wrapped in try/catch) must work on `http://nais.test:3100` (insecure-origin e2e project).
5. **Hydration/theme flash** — next-themes `suppressHydrationWarning` on `<html>`, no flash of light theme in dark; Pretendard loads without layout shift (`font-display: swap` with matching fallback metrics via `size-adjust` not required, but no FOIT).

## Parallelization

```
Task 1 (tokens, fonts, theme) → Task 2 (primitives) → Task 3 (app shell + ⌘K)
   then in parallel worktrees (all from Task 3 head):
     W-A: Task 4 (data search) → Task 5 (Data Card + Explorer) → Task 6 (versions + upload)
     W-B: Task 7 (dataset form) → Task 8 (projects)
     W-C: Task 9 (access) → Task 10 (activity + notifications)
     W-D: Task 11 (settings/org/admin) → Task 12 (dashboard, public, mock-login, errors)
   → Task 13 (visual QA sweep, after all merged)
```

Shared-file rule for parallel tasks: `apps/web/src/messages/{ko,en}.json` — add only your own keys; `packages/ui` is frozen after Task 2 except additive new components (coordinate through the controller).

---

### Task 1: Tokens, fonts, theme provider

**Files:**
- Modify: `apps/web/src/app/globals.css` (replace `@theme` with spec §2 tokens), `apps/web/src/app/layout.tsx` (font CSS imports, `suppressHydrationWarning`, viewport + two `theme-color` metas), `apps/web/src/app/providers.tsx` (wrap in `ThemeProvider`), `apps/web/package.json`
- Create: `apps/web/src/shared/ui/theme.tsx` (`ThemeProvider`, `useThemeChoice`), `apps/web/src/app/tokens.test.ts`

**Interfaces:**
- Produces: Tailwind utilities `bg-bg bg-bg-subtle bg-bg-panel bg-bg-hover bg-bg-active border-border border-border-strong text-fg text-fg-muted text-fg-subtle text-accent-fg bg-accent bg-accent-soft bg-primary text-primary-fg ring-focus`, status families `bg-success-soft text-success border-success-line` (same for warning/danger/info); text utilities `text-display text-title text-heading text-body text-small text-caption text-mono`; `font-sans font-mono`; `.num` (tabular-nums); radii `rounded-sm|md|lg`; shadows `shadow-popover shadow-dialog`; CSS vars `--ease-out --ease-in-out --ease-drawer --dur-press --dur-fast --dur-base --dur-sheet`; `ThemeProvider` (next-themes, `attribute="class"`, `defaultTheme="system"`, `enableSystem`).

- [ ] **Step 1: Write the failing token test**

```ts
// apps/web/src/app/tokens.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

describe("design tokens", () => {
  it.each(["--color-bg:", "--color-fg-muted:", "--color-primary:", "--color-accent:", "--radius-sm:", "--ease-out:", "--font-sans:"])(
    "declares %s",
    (token) => expect(css).toContain(token),
  );
  it("defines a dark variant for every color token", () => {
    const light = [...css.matchAll(/--color-([a-z-]+):/g)].map((m) => m[1]);
    const darkBlock = css.slice(css.indexOf(".dark"));
    for (const name of new Set(light)) expect(darkBlock, name).toContain(`--color-${name}:`);
  });
  it("uses only the three radii", () => {
    expect(css).toMatch(/--radius-sm:\s*6px/);
    expect(css).toMatch(/--radius-md:\s*10px/);
    expect(css).toMatch(/--radius-lg:\s*14px/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`corepack pnpm --dir apps/web test src/app/tokens.test.ts`)

- [ ] **Step 3: Install fonts and theme lib**

Run: `corepack pnpm --dir apps/web add pretendard @fontsource-variable/jetbrains-mono next-themes`

- [ ] **Step 4: Write `globals.css`**

```css
@import "tailwindcss";
@import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
@import "@fontsource-variable/jetbrains-mono";
@source "../../../../packages/ui/src";
@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --font-sans: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;

  --color-bg: #fcfcfd;          /* slate-1 */
  --color-bg-subtle: #f9f9fb;   /* slate-2 */
  --color-bg-panel: #ffffff;
  --color-bg-hover: #f0f0f3;    /* slate-3 */
  --color-bg-active: #e8e8ec;   /* slate-4 */
  --color-border: #d9d9e0;      /* slate-6 */
  --color-border-strong: #cdced6; /* slate-7 */
  --color-fg: #1c2024;          /* slate-12 */
  --color-fg-muted: #60646c;    /* slate-11 */
  --color-fg-subtle: #80838d;   /* slate-10 */
  --color-accent: #3e63dd;      /* indigo-9 */
  --color-accent-fg: #3a5bc7;   /* indigo-11 */
  --color-accent-soft: #edf2fe; /* indigo-3 */
  --color-primary: #1c2024;     /* slate-12 */
  --color-primary-hover: #2b3036;
  --color-primary-fg: #ffffff;
  --color-focus: #8da4ef;       /* indigo-8 */
  --color-focus-ring: #e1e9ff;  /* indigo-4 */
  --color-success-soft: #e9f6e9; --color-success-line: #b2ddb5; --color-success-solid: #46a758; --color-success: #2a7e3b;
  --color-warning-soft: #fff7c2; --color-warning-line: #f3d673; --color-warning-solid: #ffc53d; --color-warning: #ab6400;
  --color-danger-soft: #feebec;  --color-danger-line: #fdbdbe;  --color-danger-solid: #e5484d;  --color-danger: #ce2c31;
  --color-info-soft: #e0f8f3;    --color-info-line: #a1ded2;    --color-info-solid: #12a594;    --color-info: #008573;
  --color-chart-1: #3e63dd; --color-chart-2: #12a594; --color-chart-muted: #b9bbc6;

  --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px;
  --shadow-popover: 0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -6px rgb(0 0 0 / 0.16);
  --shadow-dialog: 0 1px 2px rgb(0 0 0 / 0.06), 0 24px 48px -12px rgb(0 0 0 / 0.28);

  --text-display: 28px; --text-display--line-height: 34px; --text-display--letter-spacing: -0.02em; --text-display--font-weight: 650;
  --text-title: 20px; --text-title--line-height: 28px; --text-title--letter-spacing: -0.015em; --text-title--font-weight: 600;
  --text-heading: 16px; --text-heading--line-height: 24px; --text-heading--letter-spacing: -0.01em; --text-heading--font-weight: 600;
  --text-body: 14px; --text-body--line-height: 22px;
  --text-small: 13px; --text-small--line-height: 20px;
  --text-caption: 12px; --text-caption--line-height: 16px; --text-caption--letter-spacing: 0.01em; --text-caption--font-weight: 500;
  --text-mono: 12.5px; --text-mono--line-height: 20px;

  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
  --dur-press: 120ms; --dur-fast: 150ms; --dur-base: 200ms; --dur-sheet: 280ms;
}

.dark {
  --color-bg: #111113; --color-bg-subtle: #18191b; --color-bg-panel: #18191b; --color-bg-hover: #212225; --color-bg-active: #272a2d;
  --color-border: #363a3f; --color-border-strong: #43484e;
  --color-fg: #edeef0; --color-fg-muted: #b0b4ba; --color-fg-subtle: #777b84;
  --color-accent: #3e63dd; --color-accent-fg: #9eb1ff; --color-accent-soft: #182449;
  --color-primary: #edeef0; --color-primary-hover: #d9dbde; --color-primary-fg: #111113;
  --color-focus: #435db1; --color-focus-ring: #1d2e62;
  --color-success-soft: #1b2a1e; --color-success-line: #2d5736; --color-success-solid: #46a758; --color-success: #71d083;
  --color-warning-soft: #302008; --color-warning-line: #5c3d05; --color-warning-solid: #ffc53d; --color-warning: #ffca16;
  --color-danger-soft: #3b1219;  --color-danger-line: #72232d;  --color-danger-solid: #e5484d;  --color-danger: #ff9592;
  --color-info-soft: #0d2d2a;    --color-info-line: #145750;    --color-info-solid: #12a594;    --color-info: #0bd8b6;
  --color-chart-1: #5472e4; --color-chart-2: #0eb39e; --color-chart-muted: #5a6169;
  --shadow-popover: 0 0 0 1px #363a3f, 0 8px 24px -6px rgb(0 0 0 / 0.5);
  --shadow-dialog: 0 0 0 1px #363a3f, 0 24px 48px -12px rgb(0 0 0 / 0.6);
  color-scheme: dark;
}

@layer base {
  html { -webkit-tap-highlight-color: transparent; -webkit-text-size-adjust: 100%; scroll-padding-top: 4rem; }
  body { background: var(--color-bg); color: var(--color-fg); font-family: var(--font-sans); font-size: 14px; line-height: 22px; font-feature-settings: "ss06"; }
  :focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  button, a, [role="button"] { touch-action: manipulation; }
  @media (max-width: 767px) { input, textarea, select { font-size: 16px; } }
}

@utility num { font-variant-numeric: tabular-nums; }
@utility press { transition: transform var(--dur-press) var(--ease-out); &:active { transform: scale(0.97); } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-property: opacity !important; transition-duration: 120ms !important; animation: none !important; }
}
```

- [ ] **Step 5: Theme provider + layout**

```tsx
// apps/web/src/shared/ui/theme.tsx
"use client";
import { ThemeProvider as NextThemes, useTheme } from "next-themes";
import type { ReactNode } from "react";

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemes attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="nais-theme">
      {children}
    </NextThemes>
  );
}

export type ThemeChoice = "system" | "light" | "dark";
export function useThemeChoice(): { choice: ThemeChoice; setChoice: (c: ThemeChoice) => void } {
  const { theme, setTheme } = useTheme();
  return { choice: (theme as ThemeChoice) ?? "system", setChoice: setTheme };
}
```

In `layout.tsx`: `<html lang={locale} suppressHydrationWarning>`, `export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: [{ media: "(prefers-color-scheme: light)", color: "#fcfcfd" }, { media: "(prefers-color-scheme: dark)", color: "#111113" }] }`. In `providers.tsx`, wrap the existing tree in `<ThemeProvider>` (outermost client provider). next-themes wraps localStorage access in try/catch already; keep `storageKey` as above.

- [ ] **Step 6: Map legacy tokens so screens keep rendering** — add aliases in `@theme` until screens migrate: `--color-background: var(--color-bg); --color-foreground: var(--color-fg); --color-muted: var(--color-bg-hover); --color-muted-foreground: var(--color-fg-muted); --color-secondary: var(--color-bg-hover); --color-secondary-foreground: var(--color-fg); --color-destructive: var(--color-danger-solid); --color-destructive-foreground: #ffffff; --color-ring: var(--color-focus);` and keep `--color-primary-foreground: var(--color-primary-fg)`. Task 13 removes them (grep must return 0 uses first).

- [ ] **Step 7: Run tests, lint, typecheck, build** — all green; take baseline screenshots (`shots/baseline-*`) of `/commons` and `/commons/data/<battery id>` at 1440 light/dark with the script in Task 3 Step 6 (create it here if Task 3 not yet run).

- [ ] **Step 8: Commit** — `feat(web): design tokens, Pretendard/JetBrains Mono, light/dark theme`

### Task 2: Primitives in `packages/ui`

**Files:**
- Modify: `packages/ui/package.json` (add `@base-ui-components/react`, `class-variance-authority`, `cmdk`, `sonner`, `react-virtuoso`; remove `@radix-ui/*` at the end of the task), every file in `packages/ui/src/`
- Create: `packages/ui/src/{icon-button,tooltip,popover,menu,select,combobox,segmented,switch,radio,tag,avatar,kbd,path-text,stat,progress,mini-histogram,sheet,toast,command}.tsx`, tests `packages/ui/src/*.test.tsx`

**Interfaces (Produces):**
- `Button` props `{ variant?: "primary"|"secondary"|"ghost"|"danger"; size?: "sm"|"md"|"lg"; loading?: boolean }`; legacy aliases accepted and mapped: `default→primary`, `outline→secondary`, `destructive→danger`, `link→ghost` + underline (kept until Task 13). `buttonClass(variant, size, className)` keeps its signature.
- `Badge` `tone: "neutral"|"success"|"warning"|"danger"|"info"|"accent"`, `dot?: boolean` (legacy tone names kept as aliases).
- `Tabs` (underline), `Dialog`, `ConfirmDialog`, `Sheet`, `Popover`, `DropdownMenu` (`Menu.Root/Trigger/Content/Item/Separator/Label`), `Tooltip` (provider with shared delay, `data-instant` after first), `Select`, `Combobox`, `SegmentedControl`, `Checkbox`, `RadioGroup`, `Switch`, `Input`, `Textarea`, `FormField`, `Tag`, `Avatar` (`name`, `size`), `Kbd`, `PathText` (`value`, middle ellipsis, copy), `Stat`, `Progress`, `MiniHistogram` (`bins: number[]`, `labels?`, `highlight?`), `DataTable` (existing API + `dense`, `stickyHeader`, `virtualize` (Virtuoso when rows > 1000)), `EmptyState` (`icon`, `title`, `description`, `action`), `Skeleton`, `notify` (Sonner headless wrapper: `notify.success|error|info|promise`), `Toaster`, `CommandMenu` (cmdk wrapper: `CommandMenu.Root/Input/List/Group/Item/Empty`).

- [ ] **Step 1: Failing tests** — one test file per component covering: render + accessible name, keyboard (Menu/Select/Combobox arrow+Enter, Esc returns focus to trigger), `Button` variant classes and `:active` press utility present (`press` class), `Tooltip` instant-after-first (fake timers), `PathText` middle ellipsis keeps head/tail and copy uses `copyText` fallback (mock `navigator.clipboard` undefined), `MiniHistogram` renders `bins.length` rects with heights proportional to max, `DataTable` virtualizes when `rows.length > 1000` (only a window of rows in DOM). Example:

```tsx
// packages/ui/src/button.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("maps legacy variants", () => {
    render(<Button variant="default">저장</Button>);
    expect(screen.getByRole("button", { name: "저장" }).className).toContain("bg-primary");
  });
  it("keeps width and shows a spinner while loading", () => {
    render(<Button loading>저장</Button>);
    const b = screen.getByRole("button", { name: "저장" });
    expect(b).toHaveAttribute("aria-busy", "true");
    expect(b).toBeDisabled();
  });
  it("has press feedback", () => {
    render(<Button>저장</Button>);
    expect(screen.getByRole("button").className).toContain("press");
  });
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `button.tsx` with cva**

```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";

const button = cva(
  "press inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium text-body transition-[background-color,border-color,color] duration-[var(--dur-fast)] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-fg hover:bg-primary-hover",
        secondary: "border border-border bg-bg-panel text-fg hover:bg-bg-hover",
        ghost: "text-fg-muted hover:bg-bg-hover hover:text-fg",
        danger: "bg-danger-solid text-white hover:opacity-90",
      },
      size: { sm: "h-7 px-2.5 text-small", md: "h-8 px-3", lg: "h-10 px-4" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

const LEGACY = { default: "primary", outline: "secondary", destructive: "danger", link: "ghost" } as const;
type Modern = NonNullable<VariantProps<typeof button>["variant"]>;
export type ButtonVariant = Modern | keyof typeof LEGACY;
export type ButtonSize = "sm" | "md" | "lg" | "default" | "icon";

function norm(v?: ButtonVariant): Modern { return (v && (LEGACY as Record<string, Modern>)[v]) ?? (v as Modern) ?? "secondary"; }
function normSize(s?: ButtonSize): "sm" | "md" | "lg" { return s === "default" || s === "icon" || !s ? "md" : s; }

export function buttonClass(variant?: ButtonVariant, size?: ButtonSize, className?: string): string {
  return cn(button({ variant: norm(variant), size: normSize(size) }), size === "icon" && "w-8 px-0", variant === "link" && "underline underline-offset-4", className);
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, disabled, children, type = "button", ...props }, ref,
) {
  return (
    <button ref={ref} type={type} aria-busy={loading || undefined} disabled={disabled || loading} className={buttonClass(variant, size, className)} {...props}>
      {loading ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
      {children}
    </button>
  );
});
```

Note: the legacy default variant was `default` (filled). Callers that relied on the default without a `variant` prop now get `secondary`; grep `<Button` without `variant` in apps/web and set `variant="primary"` where it is the page's main action (keep the existing look-and-behaviour of primary CTAs).

- [ ] **Step 4: Implement the rest** per spec §4 table (exact heights, radii, colors via tokens). Popover/Menu/Select/Tooltip content: `rounded-md border border-border bg-bg-panel shadow-popover`, `origin-[var(--transform-origin)]`, enter `data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0` / exit `data-[ending-style]:opacity-0` with `transition-[transform,opacity] duration-[var(--dur-fast)] ease-[var(--ease-out)]`. Dialog: centered, `rounded-lg shadow-dialog`, scale 0.98→1, scrim `bg-black/40` (dark `bg-black/60`). Sheet: `translate-x-[-100%]`↔0 with `--dur-sheet --ease-drawer`. Toaster: `<Toaster position="bottom-right" theme={resolvedTheme} />` mounted once in providers; `notify.*` uses `toast.custom` with our markup (icon + title + description + close), error toasts `duration: Infinity`. CommandMenu: cmdk with no open/close animation.
- [ ] **Step 5: Replace Radix** — migrate `dialog.tsx` and `tabs.tsx` to Base UI keeping export names, remove `@radix-ui/*` deps, run all web tests (`apps/web` uses these exports — fix any test that queried Radix-specific attributes).
- [ ] **Step 6: Storybook-less gallery page** — create `apps/web/src/app/(platform)/commons/_ui/page.tsx` (route `/commons/_ui`, only when `isMocking`) rendering every component in all variants and states, light/dark side by side; used by reviewers' screenshots. Exclude from real-mode builds via `notFound()` when not mocking.
- [ ] **Step 7: Green (ui + web tests, lint, typecheck, build), screenshot `/commons/_ui` at 1440 light/dark → `shots/ui-gallery-*.png`.**
- [ ] **Step 8: Commit** — `feat(ui): primitives on Base UI with cva variants, Sonner, cmdk, gallery`

### Task 3: App shell, ⌘K, notifications, user menu

**Files:**
- Rewrite: `apps/web/src/shared/ui/app-shell.tsx`, `notification-bell.tsx`, `user-menu.tsx`, `page-header.tsx`, `toast.tsx` (re-export `notify`), `state-views.tsx`
- Create: `apps/web/src/shared/ui/{sidebar.tsx,top-bar.tsx,breadcrumbs.tsx,command-palette.tsx}`, `apps/web/e2e/screens.spec.ts` (screenshot harness), `apps/web/scripts/shots.mjs` (optional CLI wrapper)
- Tests: `apps/web/src/features/shell/platform-shell.test.tsx` (update), new `command-palette.test.tsx`

**Interfaces:**
- Consumes: Task 2 primitives, `useThemeChoice`.
- Produces: `PageHeader({ title, description?, meta?, actions?, badges? })`, `useBreadcrumbs(items)` (context consumed by `TopBar`), `CommandPalette` opened by ⌘K/Ctrl+K and the top-bar button; screenshot harness `shoot(page, name)` saving `shots/<name>-<width>-<theme>.png`.

- [ ] **Step 1: Failing tests** — sidebar renders groups 작업/거버넌스/관리 with role-gated items (기관 only for ORG_ADMIN or PLATFORM_ADMIN), active item has `aria-current="page"`; collapse toggle persists (localStorage mocked to throw → still works); ⌘K opens the palette (`fireEvent.keyDown(document, { key: "k", metaKey: true })`), typing filters items, Enter navigates (mock router), Esc closes and returns focus; notification popover lists items and "모두 읽음"; user menu has theme radio (시스템/라이트/다크) and 로그아웃; at 390px (matchMedia mock) a "메뉴" button opens the sidebar sheet.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** per spec §3 (240px sidebar on `bg-bg-subtle` with right border, 32px items, 16px icons from lucide: LayoutDashboard, FolderKanban, Database, NotebookPen (disabled "예정" badge), ShieldCheck, Activity, Building2; top bar 48px with breadcrumbs left, bell + ⌘K button right; content `mx-auto max-w-[1200px] px-8 py-6`, mobile `px-4`). The review-count badge on 접근 관리 uses the existing access-requests query (`role=reviewer`, status SUBMITTED/UNDER_REVIEW) only for DATA_STEWARD users.
- [ ] **Step 4: ⌘K** — groups: 이동(all nav), 데이터셋(server search via existing `searchDatasets` hook, debounce 150ms, top 8), 프로젝트(listProjects filter client-side), 행동(새 데이터셋 — steward only, 새 프로젝트, 테마 전환). No animation. Shortcut hint `Kbd` in the top-bar button.
- [ ] **Step 5: Screenshot harness**

```ts
// apps/web/e2e/screens.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = "../../.superpowers/sdd/2026-10-01-ui-redesign/shots";
mkdirSync(OUT, { recursive: true });
const USERS = { steward: "00000000-0000-7000-8000-000000000b03", researcher: "00000000-0000-7000-8000-000000000a02", admin: "00000000-0000-7000-8000-000000000101" };

export async function shoot(page: Page, name: string) {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    for (const theme of w === 390 ? ["light"] : ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: theme as "light" | "dark", reducedMotion: "reduce" });
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png`, fullPage: true });
    }
  }
}

async function as(page: Page, who: keyof typeof USERS) {
  await page.context().addCookies([{ name: "nais_mock_user", value: USERS[who], url: page.url() === "about:blank" ? "http://localhost:3100" : page.url() }]);
}

test.describe("screens", () => {
  test.skip(({ browserName }, info) => info.project.name !== "chromium", "screenshots once");
  test("shell", async ({ page }) => {
    await as(page, "steward");
    await page.goto("/commons");
    await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
    await shoot(page, "shell-dashboard");
  });
});
```

Later screen tasks append one `test(...)` per screen to this file. Run with `corepack pnpm --dir apps/web exec playwright test e2e/screens.spec.ts --project=chromium`.
- [ ] **Step 6: Green + screenshots (`shell-*`). Commit** — `feat(web): app shell with sidebar, breadcrumbs, ⌘K, notification and user menus`

### Task 4: Data search

**Files:** `apps/web/src/features/catalog/data-search-screen.tsx`, `components/{facet-panel,period-filter,principal-investigator-filter,search-result-card}.tsx`, `catalog.test.tsx`, `e2e/screens.spec.ts`
- [ ] Step 1: Update/extend tests: filter rail is a `complementary` landmark named "필터"; vocabulary facets render as tree checkboxes with counts (`num`); result rows show title, subtitle, meta line (기관 · 책임자 · 기간 · 버전 · 파일 수 · 용량), AI-ready and access badges; list/table view toggle (`SegmentedControl` "목록|표") persists in URL `view=`; 0 results shows EmptyState with "필터 초기화".
- [ ] Step 2: FAIL → Step 3: implement per spec §6 "데이터 검색" (rail 240px, toolbar search 320px + sort Select + result count `num`, rows separated by 1px borders, no cards). Table view uses `DataTable` columns 제목/기관/기간/수정일/AI-ready.
- [ ] Step 4: Screens test `data-search` (steward) and `data-search-empty` (`?q=zzzz`). Step 5: Green, commit `feat(web): data search redesign`.

### Task 5: Data Card + Data Explorer

**Files:** `features/catalog/dataset-detail-screen.tsx`, `data-card/*`, `explorer/*`, `components/{ai-ready-badge,person-line,vocabulary-tags,markdown}.tsx`, tests `data-card.test.tsx`, `explorer.test.tsx`, `e2e/screens.spec.ts`
- [ ] Step 1: Tests keep all existing behaviour assertions; add: header renders `h1` (text-display) + subtitle + meta line with PI (NTIS) + period + latest version; actions order 문의 · (새 노트북 disabled "예정") · 다운로드/접근 요청 primary; right rail `complementary` with 담당자/연구책임자/이용 정책/활동 sections; Explorer is a bordered panel with file tree grouped by role (RAW/PROCESSED/DOCS when role exists, otherwise a single 파일 group), `SegmentedControl` Detail/Compact/Column, `MiniHistogram` per numeric column, gated notice shows AccessCta.
- [ ] Step 2: FAIL → Step 3: implement per reference artboard A (https://claude.ai/artifact/PQnqyQULwadNWNh9VHfLBe) and spec §6 "데이터 상세". About max 72ch at 15/26. Column stats in `font-mono num`. Metadata as `<dl>` grid `140px 1fr`.
- [ ] Step 4: Screens `data-card-steward`, `data-card-researcher-gated` (researcher on CONTROLLED battery), `data-card-explorer-column` (click Column). Step 5: Green, commit `feat(web): Data Card and Data Explorer redesign`.

### Task 6: Versions tab, version detail, upload

**Files:** `features/catalog/version-detail-screen.tsx`, versions tab component in `data-card/`, `features/upload/components/upload-panel.tsx`, `components/new-version-dialog.tsx`, tests `version-detail.test.tsx`, `upload-panel.test.tsx`, `e2e/screens.spec.ts`
- [ ] Step 1: Tests: versions list rows show label (mono), status pill, change note, publisher avatar+name, date, file count; DRAFT rows only for steward; version detail file `DataTable` (path `PathText`, size `num` right-aligned, sha `PathText` short + copy, status pill); dropzone has 1px dashed border and keyboard-activatable button; progress uses `Progress`.
- [ ] Step 2–5: implement, screens `versions-tab`, `version-detail-draft` (steward on battery draft), commit `feat(web): versions and upload redesign`.

### Task 7: Dataset register/edit form

**Files:** `features/catalog/components/{dataset-form,user-picker,vocabulary-picker,contributors-editor}.tsx`, `dataset-new-screen.tsx`, edit dialog/sheet in detail screen, `shared/ui/form-error-summary.tsx`, tests `dataset-form.test.tsx`, `catalog.test.tsx`
- [ ] Step 1: Tests: form uses the 2-column section template (≥1024px) with sections 기본 정보 / 사람 / 연구 맥락 / 데이터 정보 / 분류 / 이용 조건 / 관련 논문; `UserPicker` is a Base UI Combobox (role `combobox`, options show name·소속·NTIS); `VocabularyPicker` popover tree with limit message "최대 5개"; `DateRangePicker` (react-day-picker in popover, two text inputs remain typeable); sticky bottom action bar; edit opens a right `Sheet` (640px) instead of inline form. All existing validation tests still pass (same error texts).
- [ ] Step 2–5: implement (`corepack pnpm --dir apps/web add react-day-picker`), screens `dataset-new`, `dataset-edit-sheet`, commit `feat(web): dataset form redesign`.

### Task 8: Projects

**Files:** `features/projects/{projects-list-screen,project-detail-screen,project-new-screen}.tsx`, `components/{members-tab,project-data-tab,project-form,user-combobox}.tsx`, `projects.test.tsx`
- [ ] Tests: list is a `DataTable` (이름, 참여 기관 수 `num`, 구성원 `num`, 데이터셋 `num`, 내 역할 badge, 수정일), detail uses detail template with tabs 개요/구성원/데이터 and right rail; member invite via Combobox; empty list EmptyState with 새 프로젝트.
- [ ] Implement, screens `projects-list`, `project-detail-members`, commit `feat(web): projects redesign`.

### Task 9: Access management

**Files:** `features/governance/{access-screen,access-request-detail-screen}.tsx`, `components/*`, `access.test.tsx`
- [ ] Tests: tabs 검토할 요청(count badge)/내 요청/내 권한 with `?tab=`; requests `DataTable` (데이터셋, 요청자 avatar+기관, 목적, 기간 `num`, 상태 pill, 제출일) and row click → detail; detail = definition list + history timeline + right rail review actions (승인 primary, 변경 요청 secondary, 거절 danger) with Dialogs; download panel restyled (PathText + copy).
- [ ] Implement, screens `access-review`, `access-detail-steward`, commit `feat(web): access management redesign`.

### Task 10: Activity and notifications

**Files:** `features/audit/{activity-screen.tsx,components/audit-timeline.tsx}`, `shared/ui/notification-bell.tsx` (if not finished in Task 3), tests
- [ ] Tests: toolbar filters (기간 Select, 행동 종류 Select, 대상 검색); timeline grouped by date headers (caption, sticky); entry = time (mono `num`), actor avatar+name+org, verb phrase, target link; virtualized when > 1000 entries (Virtuoso).
- [ ] Implement, screens `activity`, `notifications-open`, commit `feat(web): activity and notifications redesign`.

### Task 11: Settings, organization, admin

**Files:** `app/(platform)/settings/{page,organization/page}.tsx`, `features/settings/components/{member-row,transfer-card}.tsx`, settings screens, `settings.test.tsx`
- [ ] Tests: settings template with left sub-nav (프로필, 연구자 번호, 화면 테마, 기관 관리 when allowed); NTIS section keeps P18 behaviour (null on clear, 409 field error); theme section uses `RadioGroup` bound to `useThemeChoice`; organization members `DataTable` with role badges and row `DropdownMenu` (역할 변경, 비활성화); transfer section only for PLATFORM_ADMIN with warning text and confirm Dialog.
- [ ] Implement, screens `settings`, `organization-admin`, commit `feat(web): settings and organization redesign`.

### Task 12: Dashboard, public landing, mock-login, error pages

**Files:** `features/dashboard/dashboard-screen.tsx`, `app/(public)/page.tsx`, `app/mock-login/page.tsx`, `features/auth/components/mock-login-form.tsx`, `app/blocked/page.tsx`, `app/not-found.tsx`, `shared/ui/state-views.tsx`, `app/(platform)/{compute,marketplace}/page.tsx`, tests
- [ ] Tests: dashboard Stat row (내 프로젝트, 검토 대기, 활성 권한, 7일 내 만료) with `num`; two-column "검토할 요청" table / "최근 활동" timeline; "내 데이터셋 최근 버전" table; each empty block has a next action. Mock-login: centered 420px panel, account rows (avatar, name, org, role badges), "체험 모드" badge, keyboard selectable. Error/blocked/not-found use EmptyState with trace id `PathText` + copy.
- [ ] Implement, screens `dashboard`, `landing`, `mock-login`, `not-found`, commit `feat(web): dashboard, landing, mock-login and error states redesign`.

### Task 13: Visual QA sweep and cleanup

**Files:** any; `apps/web/src/app/globals.css` (remove legacy aliases), `packages/ui` (remove legacy variant aliases), `e2e/screens.spec.ts`
- [ ] Step 1: Run the full screens suite; produce `shots/INDEX.md` listing every screenshot.
- [ ] Step 2: Check spec §8 checklist item by item; record each failure in `shots/QA.md` (screen, issue, fix).
- [ ] Step 3: Remove legacy token aliases and legacy Button/Badge variant names (grep shows 0 uses first); `rg -n "#[0-9a-fA-F]{3,8}\b" apps/web/src packages/ui/src --glob '!**/*.test.*' --glob '!**/mocks/**' --glob '!**/globals.css'` → 0; `rg -n "transition-all|scale-0\b|ease-in\b" apps/web/src packages/ui/src` → 0.
- [ ] Step 4: Fix all QA items, re-shoot, attach before/after pairs for the 5 most changed screens.
- [ ] Step 5: Full green (lint, typecheck, vitest web+ui, e2e both projects incl. axe, real-mode build with `grep -rl profileCsv apps/web/.next/static` → nothing). Commit `chore(web): UI QA sweep, remove legacy design aliases`.
