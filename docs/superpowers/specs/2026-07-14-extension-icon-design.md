# Play Notes Extension Icon Design

**Date:** 2026-07-14  
**Status:** Approved visual direction and placement

## Purpose

Give YouTube Detailed Summary a distinctive browser identity that remains recognizable in Chrome and Brave at the 16-pixel toolbar size. Replace the generic generated extension mark and the side panel's temporary `YS` tile with one consistent symbol.

## Approved Direction

The approved **Play Notes** mark combines two ideas:

- a red play triangle, identifying video as the source; and
- three warm-cream horizontal lines, identifying a structured written summary.

The glyph sits on a charcoal rounded-square field with a restrained warm-gray border. Its geometry stays deliberately simple: no text, gradients, shadows baked into the asset, or fine details that disappear at toolbar size.

### Palette

| Role | Color |
| --- | --- |
| Background | `#181713` |
| Border | `#4B463A` |
| Play accent | `#FF3853` |
| Summary lines | `#F1DDB0` |

These colors align with the extension's existing dark, warm-neutral reading interface while the red play accent makes the mark identifiable against both light and dark browser chrome.

## Assets and Packaging

A single reviewed SVG is the geometry source of truth. The repository also contains deterministic PNG renditions at 16, 32, 48, and 128 pixels because Chromium extension surfaces require or strongly prefer raster assets at declared sizes.

The production and test manifests explicitly declare:

- extension icons at 16, 32, 48, and 128 pixels; and
- toolbar action icons at 16, 32, and 48 pixels.

WXT copies the public icon directory into both packaged builds. The visible loadable extension remains `dist/chrome-mv3`; no additional distribution directory is introduced.

## Interface Placement

The Play Notes icon appears in two product locations:

1. Chrome/Brave extension surfaces, including the toolbar, extensions menu, side-panel header supplied by the browser, and extension-management page.
2. The centered brand-mark position inside the extension's side-panel state UI, replacing the current `YS` letters.

The in-panel image is decorative because the adjacent eyebrow already says “YouTube Detailed Summary.” It therefore uses empty alternative text and does not add a duplicate accessible name. Existing layout dimensions remain stable.

The options page does not gain a separate decorative logo in this change because it currently has no equivalent brand-mark slot. Its existing textual heading remains unchanged.

## Implementation Boundaries

- Do not use YouTube's exact logo shape or wordmark.
- Do not add animation, alternate themes, badges, or user-selectable icons.
- Do not change summary behavior, provider settings, transcript extraction, or permissions.
- Keep icon generation deterministic and local; it must not require an API or network request.

## Verification

Automated verification must prove that:

- both generated manifests contain the complete icon mappings;
- every referenced PNG is present in the package;
- every PNG has the declared square dimensions;
- the side-panel centered state renders the Play Notes asset instead of `YS` text; and
- type checking, unit/component tests, production/test manifest assertions, packaged-extension tests, production build, and ZIP packaging still pass.

Manual visual verification checks the icon at toolbar size and the in-panel mark in Chrome or Brave. The final changes are reviewed through the existing Pi multi-review development loop before the pull request is declared ready.
