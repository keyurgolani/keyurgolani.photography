# Accessibility contract

Every visitor and curator surface follows these rules. #1 added them with the browser checks under `e2e/`, and each later issue checks its surface against them.

## Rules

1. Semantics. URL changes use a Next `Link` or `<a href>`. In-page state changes use `<button type="button">`, with `aria-pressed`, `aria-current="true"`, or `aria-expanded` when it toggles, selects, or discloses. The focusable element owns the handler and the name, with no handlers on non-interactive elements, no nested interactive elements, and `alt=""` on an `img` inside a named control.
2. Names. Names come from `photoEntryName()` and `photoImageAlt()`, never a filename, extension, raw index, EXIF or camera string, or unreviewed suggestion. They exist before the image loads, are unique, and start with any visible label (WCAG 2.5.3). `aria-describedby` text is a description. `ThemeToggle`'s name doesn't start with its label, an exception until #21 drops the label. Catalog surfaces always have a reviewed description or `decorative` (the #13 gate), so position-only names are for legacy surfaces and decorative photos.
3. Hover parity. Whatever hover reveals, `:focus-visible` reveals too. Nothing required is hover-only. A tap never leaves hover styles behind, so app hover styles apply only under `(hover: hover) and (pointer: fine)`. That's the target: `hoverOnlyWhenSupported` in `tailwind.config.ts` gates every `hover:` and `group-hover:` utility, and #1's slices 3 and 4 gate the raw `:hover` rules in `app/globals.css` and the CSS modules.
4. Focus. Use the focus token. No ancestor's overflow clips the ring, so pad clip and scroll containers by ring width plus offset or use an inset ring. Fixed chrome never entirely hides the ring, and leaves it fully clear when the element fits between the scroll paddings. Focus-revealed controls appear at full opacity with no fade.
5. Targets. Every standalone link, button, toggle, or thumbnail is at least 44 by 44 CSS px on its bounding box. Inline links in running text are exempt. This overrides the mockup's 42 px primary, 43 px Home rail, and 38 px sequence buttons.
6. Order. DOM order is the reading and tab order. Entry collections use no `grid-auto-flow: dense`, CSS `order`, reversed flex direction, or masonry reordering. Visual order is row-major by top edge with an 8 px tolerance, then by left edge. Fixed site chrome may lead the DOM, and site navigation precedes any photograph collection in tab order.
7. Touch. One tap activates, with no hover, long press, double tap, drag, or multi-finger gesture, except the first tap on idle Home, which #18 consumes as reveal intent.
8. Contrast. Over the bright fixture and through any scrim, text on photographs keeps 4.5:1, and control boundaries and icons 3:1.
9. Reflow. At 320 CSS px wide with a 200% root font size, revealed controls stay inside the viewport without overlap or clipping.
10. Focus return. Closing a Viewer returns focus to the entry that opened it. #9 owns the route Viewer, and #1 the legacy lightbox.
11. Curator routes. #14, #16, and #15 follow every rule, and every reorder has a non-drag alternative such as move buttons or a position field (WCAG 2.5.7).
12. Exceptions. Any axe rule disabled for a third-party widget is listed once in `e2e/support/a11y.ts`, with the reason and the issue that removes it.

## Passing the #1 checks

"Passes the #1 automated and keyboard checks at desktop and mobile widths" means the route has a spec under `e2e/` that calls `checkSurface()` on both projects and tests Enter on its links and Enter and Space on its buttons. #4, #18, #2, #3, #5, #7, #9, #12, #11, #14, #16, #15, and #21 all have it as an acceptance criterion.

`checkSurface(page, { entries, controls, chrome })` in `e2e/support/surface.ts` runs axe, checks that Tab moves through the entries in row-major visual order, and checks every entry and control for a 44 px target, a visible focus ring that no overflow clips and no `chrome` element hides, and a unique name of its own.

## Surfaces

| Surface | Spec | Owner |
|---|---|---|
| Home, `/` | `e2e/home.spec.ts` from #1 slice 4, and `e2e/home-immersive.spec.ts` from #18 | #1, then #18 for immersive mode and #4 for the authored sequence |
| Gallery, `/gallery` | `e2e/gallery.spec.ts` from #1 slice 3 | #1, until #3 retires the page |
| Lightbox on `/gallery` | `e2e/lightbox.spec.ts` from #1 slice 3 | #1, until #3 retires the page |
| About, `/about` | `e2e/about.spec.ts` from #1 slice 4 | #1 for the subset below, then #11 for the links and #12 for the artist statement |
| The focus token on the site chrome and in the lightbox | `e2e/focus-ring.spec.ts` from #1 slice 2 | #1, until #21 replaces the chrome |
| Work catalog | Added by #3 | #3 |
| Series pages | Added by #5 | #5 |
| Viewer | Added by #7 | #7, then #9 |
| Site navigation | Added by #21 | #21 |
| Curation inbox | Added by #14 | #14 |
| Publish preview | Added by #16 | #16 |
| Revision history | Added by #15 | #15 |

On `/about`, #1 checks the navigation links and theme control in full, Tab reach for the social cards and source link, the ring style on all of them, and axe. Ring clipping, reflow, and the hover-only labels there belong to #11. On `/`, #18 owns pointer and tap reach for the arrows, the first tap on idle Home, and keeping the controls visible while focus is inside them.

## Focus token

`app/globals.css` defines it right after the Tailwind directives, so it wins ties with the base utilities. A 3 px `--focus-ring-light` (`#ffffff`) outline sits outside a 3 px `--focus-ring-dark` (`#000000`) band that fills the offset. The outline survives forced colors. Tailwind appends its variants, such as `dark:` and `hover:`, to the end of the file, so a shadow variant would replace the band at the same specificity. The band's `box-shadow` is `!important` for that reason, and `--tw-shadow` keeps the element's own shadow under it. `expectFocusRingVisible()` fails when the band is missing. Keep the two colors at least 9:1 apart, so one of them reaches at least 3:1 on any background (4.58:1 for the current white and black). #21 may retune them within that rule, but not to the review shell's Focus Ice (`#d5f0ef`, about 1.15:1 on `#FAFAFA`).

The token's outline beats YARL's `outline: none`, but the app's own `!important` lightbox rules set `box-shadow` and `transition` on `.yarl__button` and `.yarl__thumbnails_thumbnail`. So the end of `app/globals.css` restates the band and `transition: none` for them, and lifts inactive thumbnails from `opacity: 0.5`. YARL also focuses its container to take arrow keys, and the thumbnail track when a focused thumbnail leaves it. Neither is a control, so neither draws the token. In a focused track, the active thumbnail draws it instead.

`html` has `scroll-padding-top: 6rem` and `scroll-padding-bottom: 8rem`, so a focused element that fits between them scrolls clear of `ThemeToggle` and `BottomBar`. Taller elements fall back to WCAG 2.4.11, which only asks that chrome doesn't hide them entirely.

## Names

`lib/a11y/photoName.ts` builds every photograph name.

| `alt` | `photoEntryName()`, for the control | `photoImageAlt()`, for the image |
|---|---|---|
| `{ kind: 'described', text }` | `<text>, photograph N of T` | `<text>` |
| `{ kind: 'decorative' }` | `Photograph N of T` | `""` |
| `{ kind: 'described', text, reviewed: false }`, a #14 draft | `Photograph N of T` | `Photograph N of T` |
| None, on legacy surfaces only | `Photograph N of T` | `Photograph N of T` |

`position` is 1-based. Both throw unless `position` and `total` are whole numbers with `1 <= position <= total`. The type only allows `reviewed: true` or no `reviewed`, and both helpers check it at runtime too. `photoEntryName()` drops trailing whitespace and a trailing `.`, `,`, `;`, or `:` before the comma, so "A gray lake." names the control "A gray lake, photograph 2 of 10". A blank description, or `text` that isn't a string, falls back to the position. `PhotoAlt` matches `PublicPhotoRecord.alt` in #13, and the first PR that imports both deletes this copy.

## Running the checks

```bash
npx playwright install chromium   # once per machine
npm run test:e2e
```

Playwright builds the site and serves it on port 3100, or on `E2E_PORT` when that is set, with `PHOTOGRAPHY_LIBRARY_DIR` pointed at an empty temp directory, so it never touches the real library. `e2e/support/test.ts` answers `/api/photos` and every photo request with the 12 fixtures `e2e/support/global-setup.ts` writes, so import `test` and `expect` from there, and call `setPhotoFixtures()` to change the list for one test. Helpers wait on `html[data-hydrated]`, never on timeouts.

| Rule | Helper in `e2e/support/` |
|---|---|
| 1 and 2 | `expectNoA11yViolations()`, `expectUniqueNames()` |
| 4 | `expectFocusRingVisible()`, `expectRingNotClipped()`, `expectNotObscured()` |
| 5 | `expectMinTargetSize()` |
| 6 | `expectTabOrderMatchesVisualOrder()`, `expectReachableWithin()` |
| 7 | `expectSingleTapActivates()` |
| 8 | `expectContrastOverImage()` |
| 9 | `expectReflow()` |

`e2e/support/helpers.spec.ts` shows each helper failing on a known-bad page. A new helper adds its case there.
