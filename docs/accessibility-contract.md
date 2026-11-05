# Accessibility contract

Every visitor and curator surface follows these rules. #1 added them with the browser checks under `e2e/`, and each later issue checks its surface against them.

## Rules

1. Semantics. URL changes use a Next `Link` or `<a href>`. In-page state changes use `<button type="button">`, with `aria-pressed`, `aria-current="true"`, or `aria-expanded` when it toggles, selects, or discloses. The focusable element owns the handler and the name, with no handlers on non-interactive elements, no nested interactive elements, and `alt=""` on an `img` inside a named control.
2. Names. Names come from `photoEntryName()` and `photoImageAlt()`, never a filename, extension, raw index, EXIF or camera string, or unreviewed suggestion. They exist before the image loads, are unique, and start with any visible label (WCAG 2.5.3). `aria-describedby` text is a description. Catalog surfaces always have a reviewed description or `decorative` (the #13 gate), so position-only names are for decorative photos, and photos `photos carry-over` brought over from the legacy Gallery with no description yet (`position`), which keep the name the Gallery gave them.
3. Hover parity. Whatever hover reveals, `:focus-visible` reveals too. Nothing required is hover-only. A tap never leaves hover styles behind, so app hover styles apply only under `(hover: hover) and (pointer: fine)`. That's the target: `hoverOnlyWhenSupported` in `tailwind.config.ts` gates every `hover:` and `group-hover:` utility, and #1's slices 3 and 4 gate the raw `:hover` rules in `app/globals.css` and the CSS modules.
4. Focus. Use the focus token. No ancestor's overflow clips the ring, so pad clip and scroll containers by ring width plus offset or use an inset ring. Fixed chrome never entirely hides the ring, and leaves it fully clear when the element fits between the scroll paddings. Focus-revealed controls appear at full opacity with no fade.
5. Targets. Every standalone link, button, toggle, or thumbnail is at least 44 by 44 CSS px on its bounding box. Inline links in running text are exempt. This overrides the mockup's 42 px primary, 43 px Home rail, and 38 px sequence buttons.
6. Order. DOM order is the reading and tab order. Entry collections use no `grid-auto-flow: dense`, CSS `order`, reversed flex direction, or masonry reordering. Visual order is row-major by top edge with an 8 px tolerance, then by left edge. Fixed site chrome may lead the DOM, and site navigation precedes any photograph collection in tab order.
7. Touch. One tap activates, with no hover, long press, double tap, drag, or multi-finger gesture, except the first tap on idle Home, which #18 consumes as reveal intent.
8. Contrast. Over the bright fixture, over the dark one wherever text or icons are dark, and through any scrim, text on photographs keeps 4.5:1, and control boundaries and icons 3:1.
9. Reflow. At 320 CSS px wide with a 200% root font size, revealed controls stay inside the viewport without overlap or clipping.
10. Focus return. Closing a Viewer returns focus to the entry that opened it. #9 owns the route Viewer. Close on a directly loaded photograph goes to `/work/<slug>?photo=<photoId>`, which opens the series on the page that holds it with focus on its entry. When the series' saved pages can't bring that photograph back, the page asks the server for the page that holds it, and only when the server's page doesn't hold it either (it left the revision) does focus go to the series heading. Opening a photograph never changes the series URL. After Show more, focus moves to the first new entry. After Show earlier, it moves to the last new entry, the one nearest the entries already shown. Neither moves focus from anywhere but its own control or the page itself (#5, #6).
11. Curator routes. #14, #16, and #15 follow every rule, and every reorder has a non-drag alternative such as move buttons or a position field (WCAG 2.5.7).
12. Exceptions. Any axe rule disabled for a third-party widget is listed once in `e2e/support/a11y.ts`, with the reason and the issue that removes it.

## Passing the #1 checks

"Passes the #1 automated and keyboard checks at desktop and mobile widths" means the route has a spec under `e2e/` that calls `checkSurface()` on both projects and tests Enter on its links and Enter and Space on its buttons. #4, #18, #2, #3, #5, #7, #9, #12, #11, #14, #16, #15, and #21 all have it as an acceptance criterion.

`checkSurface(page, { entries, controls, chrome, pseudo })` in `e2e/support/surface.ts` runs axe, checks that Tab moves through the entries in row-major visual order, and checks every entry and control for a 44 px target, a visible focus ring that no overflow clips and no `chrome` element hides, and a unique name of its own. Entries whose target and ring are a stretched link's pseudo-element, as Work's are, pass `pseudo: '::after'`, and their order, size and ring are checked on it. Controls keep their own boxes.

## Surfaces

| Surface | Spec | Owner |
|---|---|---|
| Home, `/` | `e2e/home.spec.ts` from #1 slice 4, `e2e/home-playback.spec.ts` from #2, `e2e/home-immersive.spec.ts` from #18, and `e2e/home-catalog.spec.ts` from #4, all on the catalog server's published Home since #13's slice E, `e2e/home-empty.spec.ts` for #4's empty state on a server of its own, and `e2e/home-framing.spec.ts` for #4's focal-point and contain framing on another | #1, #2 for playback and reduced motion, then #18 for immersive mode and #4 for the authored sequence |
| About, `/about` | `e2e/about.spec.ts` from #1 slice 4, and `e2e/about-links.spec.ts` from #11 | #1 for the subset below, #11 for the links, then #12 for the artist statement |
| The focus token on `SiteNav` and its theme control | `e2e/focus-ring.spec.ts` from #1 slice 2, moved onto `SiteNav` by #21 | #1, with #21 for `SiteNav` |
| Work catalog, `/work` | `e2e/work.spec.ts` from #3, on a published fixture catalog its own server serves, with #171's heading-link entries, their target and ring in all five themes, and Try again after a missing pointer on a server of its own | #3, then #171 for the entries |
| Series pages, `/work/<slug>` | `e2e/series.spec.ts` and `e2e/series-return.spec.ts` from #5, the second for Viewer entry from the cover and the sequence and the return to it | #5 |
| Viewer, `/work/<slug>/photo/<photoId>` | `e2e/viewer.spec.ts` from #7, `e2e/viewer-modal.spec.ts` and `e2e/viewer-touch.spec.ts` from #9 | #7, then #9 |
| Site navigation, `SiteNav` | `e2e/shell/nav.spec.ts` from #21, with `server-html`, `theme`, and `confinement` in `e2e/shell/` | #21, then #18 for its reveal on Home |
| Curator login, `/curation/login` | `e2e/curator-login.spec.ts` from #14's 14-2, at rest, with a refusal, and during the lock | #14 |
| Curation inbox, `/curation/inbox` | `e2e/curation-inbox.spec.ts` from #14, on a fixture its own curator server serves, and `e2e/curation-inbox-screen.spec.ts` from #14's A8, whose `checkSurface()` covers the rows, the filters, the bulk actions and the pager at both widths, in Light and Dark | #14 |
| Curator publish, `/curation/publish` | `e2e/curation-publish.spec.ts` from #16, on a fixture data root its own curator server serves: axe, 44 px targets, the focus ring and unique names at 1440 and 390, the Tab order through the blocker list, one live region, and focus after each answer. `e2e/curation-publish-frame.spec.ts` checks on WebKit too that the preview frame never scrolls the page. #15's History on it, in `e2e/curation-history.spec.ts`: axe, 44 px targets, the focus ring and unique names on History and its restore dialog at 1440 and 390, the dialog's modal Tab order, Escape and focus return, the dialog's own live region while it's open, and focus after each answer | #16, with #15 for History |
| Curator series, `/curation/series` and `/curation/series/<seriesId>` | `e2e/curation-series.spec.ts` from #150, on a fixture data root its own curator server serves: axe, 44 px targets, and the focus ring and its clipping on both pages, the button focusable while its action is out, and focus after each answer, on the field a refusal is about or on the answer | #150 |
| Revision history | Added by #15 | #15 |

On `/about`, #1 checks the navigation links and theme control in full, and Tab reach, the ring style, ring clipping, reflow, and labels at rest for the external links, plus axe. `e2e/about-links.spec.ts` runs `checkSurface()` there with those links as the entries. On `/`, #18 owns the first tap on idle Home.

## Focus token

`app/globals.css` defines it right after the Tailwind directives, so it wins ties with the base utilities. A 3 px `--focus-ring-light` (`#ffffff`) outline sits outside a 3 px `--focus-ring-dark` (`#000000`) band that fills the offset. The outline survives forced colors. Tailwind appends its variants, such as `dark:` and `hover:`, to the end of the file, so a shadow variant would replace the band at the same specificity. The band's `box-shadow` is `!important` for that reason, and `--tw-shadow` keeps the element's own shadow under it. `expectFocusRingVisible()` fails when the band is missing. Keep the two colors at least 9:1 apart, so one of them reaches at least 3:1 on any background (4.58:1 for the current white and black). #21 may retune them within that rule, but not to the review shell's Focus Ice (`#d5f0ef`, about 1.15:1 on `#FAFAFA`).

A stretched target draws the token inset instead: Work's entry (#171) is its title link, whose `::after` covers the whole entry, a layer above the print. It reaches past the entry by the cover's surround, or by the ring's width plus offset where that's more, so the ring never paints over the copy. Black's covers meet the screen's edge, so there it reaches past the copy below only. The `::after` carries the light outline at its edge, at `outline-offset: calc(-1 * var(--focus-ring-width))`, over an inset `--focus-ring-dark` band of the width plus the offset, and the link itself draws no ring. That's the same two colors the other way in, so the screen's edge, a neighbour or the print never covers it, in every theme, and the outline still survives forced colors. `expectFocusRingVisible()` takes an inset band when the offset is negative, and fails one that shows less than 3 px inside the outline.

`html` has `scroll-padding-top: 6rem` and `scroll-padding-bottom: 8rem`, so a focused element that fits between them scrolls into view with room around it. The browser scrolls only the focused element, so on Work, where the focused element is an entry's title, keyboard focus brings the whole entry into view once the browser's own scroll is done, in the next frame, when some of it is off screen. An entry that fits between the paddings scrolls in between them. One that fits the screen but not the room between them meets the edge of the screen it ran past. One taller than the screen keeps its title where the browser put it. The entry is measured with its link's `::after`, its target and ring, so the ring's edge stays on screen too. Each scroll is instant, so it never animates. That keeps a cover's top on screen on Tab down the list and on Shift+Tab back up it. Focus from a click or a tap, which isn't `:focus-visible`, doesn't bring the entry into view, and neither does the window coming back into focus (#171). Outside Home, `SiteNav` sits in normal flow, so no chrome covers a focused element. On Home it's part of the chrome, which keyboard focus reveals at full opacity with no fade and holds open, and settled Home's portrait badge sits under it and takes no pointer.

## Names

`lib/a11y/photoName.ts` builds every photograph name.

| `alt` | `photoEntryName()`, for the control | `photoImageAlt()`, for the image |
|---|---|---|
| `{ kind: 'described', text }` | `<text>, photograph N of T` | `<text>` |
| `{ kind: 'decorative' }` | `Photograph N of T` | `""` |
| `{ kind: 'described', text, reviewed: false }`, a #14 draft | `Photograph N of T` | `Photograph N of T` |
| None, as `photos carry-over` names a photo in its plan | `Photograph N of T` | `Photograph N of T` |
| `{ kind: 'position' }`, carried over at the launch with no description yet | `Photograph N of T` | `Photograph N of T` |

Work's entries aren't photographs, so they don't use these: each is one link, the series title in its h2, named by the title alone, with the short statement and the photograph count as its `aria-describedby` description. The cover is outside the link, with `alt=""` (#171).

A carried-over photo is named by its place once. In the Viewer, an untitled one says it on the image alone: the header's spelled-out position and the reading area's heading are left out, so neither the dialog, a region nor a heading repeats it. The shell still announces the position on a move, since that's an event, not a name.

`position` is 1-based. Both throw unless `position` and `total` are whole numbers with `1 <= position <= total`. The type only allows `reviewed: true` or no `reviewed`, and both helpers check it at runtime too. `photoEntryName()` drops trailing whitespace and a trailing `.`, `,`, `;`, or `:` before the comma, so "A gray lake." names the control "A gray lake, photograph 2 of 10". A blank description, or `text` that isn't a string, falls back to the position. A `title`, when the photograph has one, leads the control's name (#5): "Harbor at dusk, A gray lake, photograph 2 of 10", or "Harbor at dusk, photograph 2 of 10" with no description, its own trailing punctuation dropped the same way. A blank title, or one that isn't a string, is left out. The image's alt never takes the title. `PhotoAlt` matches `PublicPhotoRecord.alt` in #13, and the first PR that imports both deletes this copy.

## Running the checks

```bash
npx playwright install chromium webkit   # once per machine, webkit for mobile-webkit
npm run test:e2e
```

Playwright builds the site and serves it on port 3100, or on `E2E_PORT` when that is set, with `PHOTOGRAPHY_LIBRARY_DIR` pointed at an empty temp directory, so it never touches the real library. That server has published nothing, so its Home and Work show #21's error page. A second server, on `E2E_CATALOG_PORT` or 3101, serves the published Home fixture in `e2e/support/catalog-home.ts` from the same build, for Home and the pages that need a catalog. Import `test` and `expect` from `e2e/support/test.ts`, and call `setPhotoFixtures()` there to paint the catalog Home's photographs with the solid and gradient fixtures in `e2e/support/fixtures.ts`, white for the contrast checks, from the opening photograph on. Helpers wait on `html[data-hydrated]`, never on timeouts.

| Rule | Helper in `e2e/support/` |
|---|---|
| 1 and 2 | `expectNoA11yViolations()`, `expectUniqueNames()` |
| 3 | `expectHoverRulesGated()` |
| 4 | `expectFocusRingVisible()`, `expectNoFadeOnBlur()`, `expectRingNotClipped()`, `expectNotObscured()` |
| 5 | `expectMinTargetSize()` |
| 6 | `expectTabOrderMatchesVisualOrder()`, `expectReachableWithin()` |
| 7 | `expectSingleTapActivates()` |
| 8 | `expectContrastOverImage()` |
| 9 | `expectReflow()` |

The rule 4, 5 and 6 helpers but `expectReachableWithin()` take `{ pseudo: '::after' }` (or `'::before'`) for a target drawn on a positioned pseudo-element, as a stretched link's is: they measure its box, outline, band and clips, and focus stays the element's own. `measure()` in `e2e/support/measure.ts` does the measuring.

`e2e/support/helpers.spec.ts` shows each helper failing on a known-bad page. A new helper adds its case there.

## The owner's screen-reader and device pass

The automated checks can't hear a screen reader, so the owner runs this pass by hand, once, on the release candidate, before the integration gate (#184). It takes about three quarters of a day. Run each step on the devices it names, with the screen reader's default settings, and note the device, browser and screen reader versions at the top of #184.

Each step says what to do, then what to expect: the names, roles and live-region text the code gives, cited by file and line, and the automated check that stands in for it where there is one. A step passes when what you hear means the same thing. VoiceOver, TalkBack and NVDA each word roles in their own way ("button", "toggle button", "pop-up button"), and that's fine. A missing name, a wrong role, text read twice, silence, or focus landing somewhere else is a finding.

Set up first:
- The candidate's visitor site, with at least two featured series on Home and a series of three photographs or more.
- The candidate's curator site, signed in, on macOS Safari, with a draft that has changes to review.
- A shell where you can run `photos` against the candidate's data root, for the steps that change something while a page is open.

### Home

- [ ] **One double-tap on a receded control, VoiceOver on iOS Safari.** Open `/` and wait for the intro to end. Touch nothing for 4 seconds, until the controls fade. Swipe right to Next photograph, then double-tap once.
  Expect: VoiceOver reads "Next photograph, button" while the controls are faded. The one double-tap moves the photograph and brings the controls back. It never takes a second double-tap. Then swipe to the navigation's Work and double-tap once: Work opens.
  Source: `components/home/HomeChromeController.tsx:290-292` lets assistive technology's click through and reveals the chrome. Stand-in: `e2e/home-immersive.spec.ts:681`.
- [ ] **One double-tap on a receded control, TalkBack on Android Chrome.** The same as the step above.
  Expect: the same. One double-tap on Next photograph moves the photograph, and one on Work opens Work.
- [ ] **Enter activates nothing, macOS Safari, with a mouse.** Click Next photograph with the mouse, then rest the pointer on the photograph and wait for the controls to fade. Press Enter.
  Expect: Enter activates nothing. The controls come back, and the position stays where it was. Only a second Enter, with the controls up, can activate anything.
  Source: `components/home/HomeChromeController.tsx:284-288` and `:302-312`. Stand-in: `e2e/home-immersive.spec.ts:455`, for Enter and Space.
- [ ] **The faded controls keep their names, VoiceOver on iOS and macOS Safari.** With the controls faded, read through the page.
  Expect: the "Primary" navigation, then a "Slideshow" group with "Previous photograph", the position (`03 / 12`), "Next photograph" and "Pause slideshow". After Pause, the button is "Play slideshow". Under reduced motion it's dimmed, and described by "Off with reduced motion".
  Source: `components/home/HomeSequenceControls.tsx:51-85`. Stand-in: `e2e/home-immersive.spec.ts:657`.
- [ ] **The carousel, VoiceOver on macOS Safari.** With the VoiceOver cursor, move into the photograph.
  Expect: a region named for the series on screen, read as a carousel. Inside it, a group named "3 of 12", read as a slide, with the photograph's description as its image. Only the slide on screen is read.
  Source: `components/home/CatalogSequence.tsx:117-143`.
- [ ] **What Home says after your own move, and while it plays, VoiceOver on macOS Safari.** Let Home play for 30 seconds. Then press Next photograph.
  Expect: while Home moves by itself, VoiceOver says nothing. After your Next, once the photograph is on screen, it says the slide and its description, politely: "4 of 12, <description>". When your move crosses into another series, it also says "Now showing <series title>". Listen to whether the two lines at a crossing read in a sensible order, or one cuts the other off.
  Source: the carousel's own live region, `components/home/CatalogSequence.tsx:171-174`, off while Home moves itself (`components/home/CatalogHome.tsx:383`); "Now showing" in the status region, `components/home/CatalogHome.tsx:172-176` and `:439-442`.
- [ ] **The story's links, VoiceOver on macOS Safari.** Read the story under the title, then open a series and read its links to Work.
  Expect: the series title as the heading level 1, its short statement, then the links "Enter the series" and "All bodies of work". On the series page, the same place is called "All work": the top link reads "All work, back to the series list", and the one at the end "All work". All three go to Work. Say whether two names for one place is a problem.
  Source: `components/home/CatalogHome.tsx:425-434`, and `components/series/SeriesPage.tsx:20-26`.

### Site navigation and the theme menu

- [ ] **The navigation and the current page, VoiceOver on iOS and macOS Safari.** On `/`, `/work` and `/about`, read the navigation.
  Expect: the "Primary" navigation, with the links "KG, Keyur Golani", "Home", "Work" and "About", then the theme button. The link for the page you're on is read as the current page. On a series page or the Viewer, it's Work.
  Source: `components/site/SiteNav.tsx:25-39`. Stand-ins: `e2e/shell/nav.spec.ts:49`, and `e2e/home-immersive.spec.ts:657` for Home.
- [ ] **The theme menu, VoiceOver on iOS and macOS Safari.** Move to the theme button and open it. Move through the choices, choose one, then close the menu: Escape on a Mac, the two-finger scrub on iOS.
  Expect: the button reads "Theme: Dark", or "Theme: System (Dark now)" while System is chosen. It opens a popover with a group named "Theme" and five radio buttons: System, Light, Bright, Dark and Black, each read with its one-line note, with the checked one said, and its place, "3 of 5". On a Mac, Tab lands on the checked choice and the arrow keys choose. A choice applies at once, and the button's name follows it. Escape closes the popover, and focus goes back to the button.
  Source: `components/ThemeMenu.tsx:25-41` and `:87-161`. Stand-ins: `e2e/about.spec.ts:59`, and `e2e/shell/theme.spec.ts:107`.
- [ ] **Work's entries, VoiceOver on macOS Safari.** Follow Work. Move to the first entry's link, then read on line by line.
  Expect: each entry is a heading level 2 whose link is named by the series title alone. After a pause, VoiceOver reads its description: the short statement, then the count, "12 photographs". Reading on, it reads the statement and the count again, as text. That's what a description on visible text does. Say whether it's too much on Work.
  Source: `components/work/SeriesCatalog.tsx:41-69`.

### The Viewer

- [ ] **On a phone, screen reader off, iPhone Safari and Android Chrome.** From a series page, tap a photograph. Swipe left, then right. Go to the last photograph and swipe left again. Double-tap the photograph, then press Zoom. Close.
  Expect: the Viewer opens over the series. A swipe left is the next photograph, and right the previous. At an end the photograph pulls a little and slides back. A double-tap on the photograph zooms it, and so does Zoom. A move resets the zoom. Close lands on the series, where you left it.
  Source: `components/viewer/useSwipe.ts:116` and `components/viewer/useDoubleTap.ts:71` take touch only. Stand-ins: `e2e/viewer-touch.spec.ts:157`, `:408` and `:903`.
- [ ] **On a phone, screen reader on, VoiceOver on iPhone Safari and TalkBack on Android Chrome.** From a series page, open a photograph. Move with Next photograph, then go to the last photograph and press Next photograph again. Press Zoom, then Close.
  Expect: the Viewer opens as a dialog named "<series title>, photograph 3 of 12", with focus on Close. A quarter second after each move lands, one polite message: "Photograph 4 of 12. <Title>. <Description>.", or "Photograph 4 of 12." for a photograph with neither. At the last photograph, Next photograph stays put and says "Last photograph in <series title>."; at the first, Previous photograph says "First photograph in <series title>.". Zoom reads as a toggle, pressed once zoomed, and the photograph becomes a scrollable region named "Zoomed photograph". Close lands on the series with focus on the photograph that opened the Viewer.
  Source: `components/viewer/ViewerShell.tsx:66` (the quarter second), `:272-273`, `:353` and `:765-780`; `components/viewer/viewerLabels.ts:85-132`; `components/viewer/ViewerChrome.tsx:84-107`; `components/viewer/StoryViewer.tsx:256-260`; focus back, `components/viewer/ViewerHost.tsx:129-139`. Stand-ins: `e2e/viewer-modal.spec.ts:168` and `:206`, `e2e/viewer-input.spec.ts:138`.
- [ ] **The end message twice, with each screen reader.** With VoiceOver on iOS and macOS Safari, TalkBack on Android Chrome and NVDA with Chrome, go to the last photograph. Press Next photograph twice. Then go to the first and press Previous photograph twice.
  Expect: the end message is spoken both times, on both presses, at both ends. The second one comes a tenth of a second after it's cleared. If a screen reader drops it, that's a finding: say which one.
  Source: `components/viewer/ViewerShell.tsx:68` and `:216-228`. Stand-in: `e2e/viewer-touch.spec.ts:962`.
- [ ] **The modal, VoiceOver with Safari and NVDA with Chrome.** On a desktop, open a photograph from a series page. Tab through it, both ways. Press Zoom, then Escape, then Escape again.
  Expect: a dialog named "<series title>, photograph 3 of 12", with focus on Close, and Tab and Shift+Tab never leave it for the series page behind. The heading level 1 reads the same as the dialog's name, and the visible `03 / 12` isn't read. With a caption, the caption is read; with none, the photograph's description is read once, from the image, and the "Description" text under it isn't read again. "Show technical details" reads as collapsed, then expanded. The first Escape only resets the zoom, with focus on Zoom; the next closes the dialog, with focus back on the photograph that opened it.
  Source: `components/viewer/ViewerShell.tsx:422` and `:773-780`; `components/viewer/ViewerChrome.tsx:84-93`; `components/viewer/StoryViewer.tsx:278-312`. Stand-ins: `e2e/viewer-modal.spec.ts:168`, `:178` and `:189`, `e2e/viewer-input.spec.ts:118`, `e2e/viewer.spec.ts:475`.
- [ ] **The page, VoiceOver with Safari and NVDA with Chrome.** Load a Viewer address directly, in a new tab. Move once, then press Escape.
  Expect: no dialog. The Viewer is the page's main landmark, with one heading level 1, "<series title>, photograph 3 of 12". Focus isn't moved on load. A move is announced as in the modal. Escape does nothing, and Close is a link to the series.
  Source: `components/viewer/ViewerShell.tsx:789-798`, and `components/viewer/ViewerChrome.tsx:79-82`. Stand-ins: `e2e/viewer-modal.spec.ts:51` and `:70`.
- [ ] **A photograph that's gone, and offline, VoiceOver on macOS Safari.** With a photograph open in the modal, unpublish it with `photos`, and wait up to 30 seconds. Then open another photograph, turn the network off and press Next photograph.
  Expect: for the gone photograph, focus moves to the heading "This photograph is no longer here", and the region says "This photograph is no longer here. It was unpublished or moved after this page loaded." Its button "Back to the series" lands on the series. Offline, Next photograph stays put and says "You're offline. The next photograph couldn't load.", also shown by the controls.
  Source: `components/viewer/ViewerShell.tsx:278-280` and `:649-650`; `components/viewer/ViewerUnavailable.tsx:36-47`. Stand-ins: `e2e/viewer-revision.spec.ts:135`, `e2e/viewer-input.spec.ts:163`.

### Publish

Every Publish step is VoiceOver on macOS Safari, signed in, on `/curation/publish`.

- [ ] **The grouped ledger.** Read the ledger with the headings rotor, then read one row.
  Expect: the ledger's heading level 2, then a heading level 3 for each group with its count: "Authored · requires judgment (4)", "Derived · recalculated automatically (2)" and "Source health (1)". On the live revision, the first two are "Authored" and "Derived". A row reads its change, then is described by its state: "Blocks publishing, Stale review, Photo", for example. A text change says "removed:" before the words that went and "added:" before the new ones.
  Source: `app/curation/publish/PublishScreen.tsx:96-108`, `:158-172`, `:444-475` and `:495-500`; `lib/curation/publish-facts.ts:409-410`.
- [ ] **A collapsed group.** On a draft with more than 50 changes in one group, move to that group and open it.
  Expect: under the group's heading, a disclosure that reads "Show all 51 changes in this group", collapsed. Opened, it reads "Hide the 51 changes in this group", expanded, and the rows follow. A blocker link to a row inside a collapsed group opens the group and lands on the fix's heading.
  Source: `app/curation/publish/PublishScreen.tsx:480-512`, and `jump.ts`. Stand-in: `app/curation/publish/__tests__/PublishScreen.test.tsx`, the group of 51.
- [ ] **A review.** On a stale row, find its review control and press it.
  Expect: the ledger has no checkbox. A review is a button named for its record and row, such as "Still right, mark reviewed: <record>" or "Mark reviewed: <record>". A stale row the live revision publishes differently also has "Use the published value: <record>". After the press, focus lands on the answer and it's read; a refusal is read under the button that was pressed.
  Source: `app/curation/publish/PublishScreen.tsx:340-378` and `:407-432`; `lib/curation/publish-view.ts:79-87`. Stand-in: `e2e/curation-publish-extras.spec.ts:65`.
- [ ] **The stale live region.** With the page open, change the draft with `photos`, or reopen an Inbox item a row rests on. Wait up to a minute, or switch to another tab and back.
  Expect: one polite message, once: "1 change went stale after this page loaded: <the row>. Load the updated ledger to review it.", or "The working catalog changed after this page loaded. Load the updated ledger." The next minute says nothing new. While Validate or Publish waits, the region says that instead: "Checking revision 3."
  Source: `lib/curation/publish-watch.ts:146-157`; `app/curation/publish/PublishScreen.tsx:891-903`. Stand-ins: `e2e/curation-publish-extras.spec.ts:79`, `e2e/curation-publish.spec.ts:245`.
- [ ] **Base moved.** With the page open and focus on Validate, publish another revision with `photos`. Wait up to a minute.
  Expect: one message: "Base moved. Revision 4 went live after this page loaded. Load the updated ledger." The bar then holds only the link "Load the updated ledger", and focus moves to it. The note under the ledger's heading starts "Base moved." too.
  Source: `lib/curation/publish-watch.ts:146`; `app/curation/publish/PublishScreen.tsx:624-637` and `:768-773`; `lib/curation/publish-facts.ts:497`. Stand-in: `e2e/curation-publish-extras.spec.ts:105`.

### The Inbox

Every Inbox step is VoiceOver on macOS Safari, signed in, on `/curation/inbox`.

- [ ] **The list and its filters.** Read the page from the top, then use the filters and the pager.
  Expect: the heading level 1 "Curation inbox". A search landmark, "Filter the inbox", with the pop-up buttons "Status" and "Type", and "Apply filters", then "Clear filters" once one is set. With more than one page, "Showing 51 to 100 of 120 items" and an "Inbox pages" navigation with "Previous page" and "Next page". Each group is a heading level 2 over its list. A row's link leads with its file's name and says how long ago it opened; the open one reads as current. A row a bulk action can take has a checkbox, "Select <the row's name>", beside its link, never in it. Under a filter with nothing in it: "No item matches these filters."
  Source: `app/curation/inbox/InboxList.tsx:56-62`, `:72`, `:99-130`, `:141-155`, `:181-237`. Stand-in: `e2e/curation-inbox-screen.spec.ts:83` and `:117`.
- [ ] **One item's detail.** Open a row.
  Expect: focus lands on the item's heading level 2. Its facts are in a region named "Item details", and each box is named by its own heading. A new photograph's actions are a form named "Review".
  Source: `app/curation/inbox/InboxDetailView.tsx:218-242`, `app/curation/inbox/ItemActions.tsx:732`. Stand-in: `e2e/curation-inbox-screen.spec.ts:101`.
- [ ] **An action's error summary.** Send an action the server refuses, for example Bind with a library path that doesn't exist. Then select two rows, change one of them with `photos`, and press "Decide later on selected".
  Expect: a refusal about a field moves focus to that field, which reads its own error. The summary beside it, "There is a problem with this item", with the links "Item: <file>" and the field, isn't read out a second time. A refusal about no field is read once, politely, as a summary whose heading is the refusal, with the link "Item: <file>". The bulk press reads what went through once, in "Bulk answer", then focus moves to a summary such as "1 item was left as it is", with a link to the row that changed.
  Source: `app/curation/inbox/ErrorSummary.tsx:17-55`; `app/curation/inbox/ItemActions.tsx:120-132`, `:166` and `:205-222`; `app/curation/inbox/BulkActions.tsx:53-95`. Stand-in: `e2e/curation-inbox-screen.spec.ts:148`.
- [ ] **The stale notice's `role="alert"`.** Open a new photograph's item and type in its description. Change the same item with `photos`, then wait up to a minute.
  Expect: an alert, read at once and once: "This item changed since the page loaded, in another tab or from the command line, so an action on it now would write nothing. Your edits are still in the form, so copy anything you want to keep before you refresh.", with the link "Refresh and review again". What you typed is still there.
  Source: `app/curation/inbox/ItemActions.tsx:136-160`. Stand-in: `e2e/curation-inbox-screen.spec.ts:166`.
- [ ] **New items and offline.** With the page open, add a photograph to the library and wait up to a minute. Then turn the network off, and on again.
  Expect: one polite message in "Inbox updates": "1 new item needs judgment. Refresh the inbox to see it.", then the link "Refresh the inbox". Listen to whether the link's words read as a repeat. Offline, an "Offline" region appears and its text is read once; back online, "Back online. The inbox is checking for changes again."
  Source: `lib/curation/inbox-watch.ts:40` and `:276-318`; `app/curation/inbox/InboxWatch.tsx:98-122`. Stand-ins: `e2e/curation-inbox-screen.spec.ts:166` and `:197`.

### What to do with a finding

Each finding gets its own bug issue in the v2.0.0 milestone before the cut. The issue names the device, browser and screen reader with their versions, the step, what you heard, and what the step expects. Or the owner accepts it in writing, on #184, with the reason, and the step's expectation changes to match in the same PR that ships the release.

The release's fix round builds the bugs. The integration gate then runs again on the fixed candidate, and the steps a fix touched run again here.
