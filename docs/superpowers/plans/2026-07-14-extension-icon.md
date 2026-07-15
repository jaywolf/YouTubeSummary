# Play Notes Extension Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Play Notes icon in Chrome/Brave extension surfaces and replace the side panel's temporary `YS` mark.

**Architecture:** Store a vector master and 16/32/48/128 PNG renditions under WXT's `public/icon` tree. Declare exact extension and action icon maps in `wxt.config.ts`; reuse the packaged 128px rendition as a decorative side-panel image. Extend existing manifest and component tests to enforce the contract.

**Tech Stack:** WXT, Manifest V3, React, TypeScript, Vitest/Testing Library, Node manifest validator, SVG, PNG.

## Global Constraints

- Use the approved charcoal `#181713`, border `#4B463A`, play accent `#FF3853`, and summary-line `#F1DDB0` palette.
- Generate square PNGs at exactly 16, 32, 48, and 128 pixels from one reviewed SVG geometry source.
- Declare extension icons at 16/32/48/128 and toolbar action icons at 16/32/48.
- Keep the loadable extension at `dist/chrome-mv3`; create no additional distribution directory.
- Replace the side panel `YS` mark with a decorative icon using empty alternative text.
- Do not change permissions, provider behavior, summarization, transcript extraction, dependencies, or settings.
- Do not use YouTube's exact logo shape or wordmark.

---

### Task 1: Package and validate Play Notes assets

**Files:**
- Create: `public/icon/play-notes.svg`
- Create: `public/icon/16.png`
- Create: `public/icon/32.png`
- Create: `public/icon/48.png`
- Create: `public/icon/128.png`
- Modify: `wxt.config.ts`
- Modify: `tests/manifest.mjs`

**Interfaces:**
- Consumes: WXT `manifest` configuration and its public-directory copy behavior.
- Produces: `/icon/{16,32,48,128}.png` packaged resources and explicit `manifest.icons` / `manifest.action.default_icon` mappings.

- [ ] **Step 1: Add failing manifest and PNG-dimension assertions**

Extend `tests/manifest.mjs` with exact mappings and a PNG-header reader that validates each referenced file's width and height.

- [ ] **Step 2: Run the production manifest test and verify RED**

Run: `pnpm test:manifest`  
Expected: FAIL because the manifest has no icon mappings.

- [ ] **Step 3: Add vector master, PNG renditions, and manifest mappings**

Use the approved SVG view box and geometry. Set:

```ts
icons: {
  16: "icon/16.png",
  32: "icon/32.png",
  48: "icon/48.png",
  128: "icon/128.png"
},
action: {
  default_title: "Summarize this YouTube video",
  default_icon: {
    16: "icon/16.png",
    32: "icon/32.png",
    48: "icon/48.png"
  }
}
```

- [ ] **Step 4: Run both manifest validators and verify GREEN**

Run: `pnpm test:manifest && pnpm test:manifest:test`  
Expected: both commands exit 0 and validate all copied PNG dimensions.

### Task 2: Replace the side-panel monogram and update documentation

**Files:**
- Modify: `tests/components/sidepanel.test.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `entrypoints/sidepanel/styles.css`
- Modify: `README.md`
- Modify: `docs/manual-verification.md`
- Modify: `docs/superpowers/specs/2026-07-13-youtube-summary-extension-design.md`

**Interfaces:**
- Consumes: packaged `/icon/128.png` and the existing `.brand-mark` layout slot.
- Produces: a decorative `<img className="brand-mark" src="/icon/128.png" alt="" />` in centered error states.

- [ ] **Step 1: Add a failing component assertion**

In the existing error-state test, assert that the image with class `brand-mark` uses `/icon/128.png`, has `alt=""`, and that `YS` is absent.

- [ ] **Step 2: Run the side-panel component test and verify RED**

Run: `pnpm test tests/components/sidepanel.test.tsx`  
Expected: FAIL because the error state still renders text `YS`.

- [ ] **Step 3: Render and style the packaged icon**

Replace the monogram element with the decorative image. Keep the 44px layout box and use `display:block; object-fit:contain; border-radius:13px`; remove text-only typography and border styling now baked into the asset.

- [ ] **Step 4: Update user and verification documentation**

Document Play Notes asset locations, manifest coverage, how to reload an unpacked extension after rebuilding, and manual checks at toolbar and side-panel sizes.

- [ ] **Step 5: Run the side-panel component test and verify GREEN**

Run: `pnpm test tests/components/sidepanel.test.tsx`  
Expected: the test file passes with no failures.

### Task 3: Verify, review, and publish the checkpoint

**Files:**
- Verify all icon-related files from Tasks 1–2.

**Interfaces:**
- Consumes: committed icon implementation.
- Produces: passing local verification, one scoped Pi code-review artifact, pushed branch, and updated PR.

- [ ] **Step 1: Run full local verification**

Run: `pnpm check && pnpm test:extension && pnpm build && pnpm zip && pnpm audit --prod && git diff --check`  
Expected: every command exits 0.

- [ ] **Step 2: Inspect generated assets**

Confirm `dist/chrome-mv3/manifest.json` references the PNG files and visually inspect the 128px asset plus a nearest-neighbor enlargement of the 16px asset.

- [ ] **Step 3: Commit the implementation checkpoint**

Commit only the scoped icon implementation, tests, and documentation.

- [ ] **Step 4: Run one scoped Pi code review**

Review only the icon assets' SVG source, manifest configuration, validator, side-panel integration, and icon documentation against the preceding committed checkpoint. Do not run a full PR review.

- [ ] **Step 5: Triage findings and rerun if required**

Fix only reproducible, technically sound blockers; rerun affected tests and the same scoped review if executable files change.

- [ ] **Step 6: Push and update PR #1**

Push `feature/ytsummary-extension`, confirm PR #1 still targets `develop`, and post concise verification evidence.
