import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './a11y';
import { expectContrastOverImage } from './contrast';
import { expectFocusRingVisible, expectNoFadeOnBlur, expectNotObscured, expectRingNotClipped } from './focus';
import { expectHoverRulesGated } from './hover';
import { expectReachableWithin, expectTabOrderMatchesVisualOrder } from './keyboard';
import { expectReflow } from './reflow';
import { checkSurface, expectUniqueNames } from './surface';
import { parkPointer, recordDispatchedEvents } from './synthetic';
import { expectMinTargetSize } from './targets';
import { expectSingleTapActivates } from './touch';

// Each helper passes a page that meets its rule and fails a known-bad page for
// the reason it names. The pages set html[data-hydrated], which helpers wait on.

const BASE_STYLE = `
    :root { --focus-ring-light: #fff; --focus-ring-dark: #000; }
    body { margin: 0; font: 16px/1.5 sans-serif; color: #111; background: #fff; }
    button { min-width: 44px; min-height: 44px; }
    :focus-visible { outline: 3px solid var(--focus-ring-light); outline-offset: 3px; box-shadow: 0 0 0 3px var(--focus-ring-dark); }
`;

async function load(page: Page, body: string, style = ''): Promise<void> {
    await page.setContent(`<!doctype html>
<html lang="en" data-hydrated="true">
<head><meta charset="utf-8"><title>Helper self-test</title><style>${BASE_STYLE}${style}</style></head>
<body><main>${body}</main></body>
</html>`);
}

test.describe('waitForHydration', () => {
    test('holds the helpers until html[data-hydrated] appears', async ({ page }) => {
        // No marker at load. After 300 ms the page gets a nameless button and the marker together.
        await page.setContent(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Helper self-test</title></head>
<body><main></main><script>
    setTimeout(() => {
        document.querySelector('main').innerHTML = '<button type="button"></button>';
        document.documentElement.dataset.hydrated = 'true';
    }, 300);
</script></body>
</html>`);
        await expect(expectNoA11yViolations(page)).rejects.toThrow(/button-name/);
    });
});

test.describe('expectNoA11yViolations', () => {
    test('passes named controls', async ({ page }) => {
        await load(page, '<button type="button">Open</button>');
        await expectNoA11yViolations(page);
    });

    test('fails a button with no name', async ({ page }) => {
        await load(page, '<button type="button"></button>');
        await expect(expectNoA11yViolations(page)).rejects.toThrow(/button-name \(critical\)/);
    });

    test('with include, checks only that part of the page', async ({ page }) => {
        await load(page, '<nav aria-label="Primary"><a href="/">Home</a></nav><button type="button"></button>');
        await expectNoA11yViolations(page, { include: 'nav[aria-label="Primary"]' });
        await expect(expectNoA11yViolations(page, { include: 'button' })).rejects.toThrow(/button-name \(critical\)/);
    });
});

test.describe('expectMinTargetSize', () => {
    test('passes a 44 by 44 button', async ({ page }) => {
        await load(page, '<button type="button" style="width: 44px; height: 44px; padding: 0; border: 0">A</button>');
        await expectMinTargetSize(page.getByRole('button'), 44);
    });

    test('fails a 30 px button', async ({ page }) => {
        await load(page, '<button type="button" style="width: 30px; height: 30px; min-width: 0; min-height: 0; padding: 0; border: 0">A</button>');
        await expect(expectMinTargetSize(page.getByRole('button'), 44)).rejects.toThrow(/is 30\.0 by 30\.0/);
    });
});

test.describe('expectFocusRingVisible', () => {
    test('passes the focus token ring', async ({ page }) => {
        await load(page, '<button type="button">Ring</button>');
        await expectFocusRingVisible(page.getByRole('button'));
    });

    test('fails outline: none', async ({ page }) => {
        await load(page, '<button type="button">Ring</button>', 'button:focus-visible { outline: none; }');
        await expect(expectFocusRingVisible(page.getByRole('button'))).rejects.toThrow(/outline-style is none/);
    });

    test("fails the browser's default 1 px ring", async ({ page }) => {
        await load(page, '<button type="button">Ring</button>', 'button:focus-visible { outline: revert; box-shadow: none; }');
        await expect(expectFocusRingVisible(page.getByRole('button'))).rejects.toThrow(/outline is 1px wide, under 3px/);
    });

    test('fails when a later shadow rule replaces the band', async ({ page }) => {
        // Like a Tailwind dark: or hover: shadow variant, which lands after the token at the same specificity.
        await load(page, '<button type="button" class="lifted">Ring</button>', '.lifted { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5); }');
        await expect(expectFocusRingVisible(page.getByRole('button'))).rejects.toThrow(/doesn't start with the token's rgb\(0, 0, 0\) band/);
    });

    test('fails a band in another color', async ({ page }) => {
        await load(page, '<button type="button">Ring</button>', 'button:focus-visible { box-shadow: 0 0 0 3px #777; }');
        await expect(expectFocusRingVisible(page.getByRole('button'))).rejects.toThrow(/the band is rgb\(119, 119, 119\), not the token's rgb\(0, 0, 0\)/);
    });

    test('fails a band that leaves a gap under the outline', async ({ page }) => {
        await load(page, '<button type="button">Ring</button>', 'button:focus-visible { box-shadow: 0 0 0 1px var(--focus-ring-dark); }');
        await expect(expectFocusRingVisible(page.getByRole('button'))).rejects.toThrow(/the band spreads 1px, short of the 3px outline offset/);
    });

    test('fails a page without the focus token', async ({ page }) => {
        await load(page, '<button type="button">Ring</button>', ':root { --focus-ring-dark: initial; }');
        await expect(expectFocusRingVisible(page.getByRole('button'))).rejects.toThrow(/no --focus-ring-dark is in scope/);
    });

    test('fails a ring that transitions in', async ({ page }) => {
        await load(page, '<button type="button">Ring</button>', 'button { transition: all 60s; }');
        await expect(expectFocusRingVisible(page.getByRole('button'))).rejects.toThrow(/all has a 60s transition under focus/);
    });

    test('fails a declared fade even when nothing is mid-transition', async ({ page }) => {
        // Opacity doesn't change on focus, so only the computed style shows the fade.
        await load(page, '<button type="button">Ring</button>', 'button { transition: opacity 60s; }');
        await expect(expectFocusRingVisible(page.getByRole('button'))).rejects.toThrow(/opacity has a 60s transition under focus/);
    });

    test('fails under an opacity: 0.5 parent', async ({ page }) => {
        await load(page, '<div id="faded" style="opacity: 0.5"><button type="button">Ring</button></div>');
        await expect(expectFocusRingVisible(page.getByRole('button'))).rejects.toThrow(/div#faded has opacity 0\.5/);
    });
});

test.describe('expectNoFadeOnBlur', () => {
    test('passes a control that only transitions its colors', async ({ page }) => {
        await load(page, '<button type="button">Ring</button>', 'button { transition: background-color 60s, color 60s; } :focus-visible { transition: none; }');
        await expectNoFadeOnBlur(page.getByRole('button'));
    });

    test('fails a band that fades out under transition: all', async ({ page }) => {
        // Like transition-all, which the token's transition: none only covers while focus lasts.
        await load(page, '<button type="button">Ring</button>', 'button { transition: all 60s; } :focus-visible { transition: none; }');
        await expect(expectNoFadeOnBlur(page.getByRole('button'))).rejects.toThrow(/box-shadow/);
    });
});

test.describe('expectRingNotClipped', () => {
    test('passes a clip container padded by ring width plus offset', async ({ page }) => {
        await load(page, '<div style="overflow: hidden; padding: 6px; width: max-content"><button type="button" style="width: 100px">Padded</button></div>');
        await expectRingNotClipped(page.getByRole('button'));
    });

    test("passes an absolute button outside a static ancestor's overflow", async ({ page }) => {
        await load(page, `
            <div style="position: relative; margin: 24px">
                <div style="overflow: hidden; width: 20px; height: 20px">
                    <button type="button" style="position: absolute; top: 0; left: 0; width: 100px">Escapes</button>
                </div>
            </div>`);
        await expectRingNotClipped(page.getByRole('button'));
    });

    test('fails a ring clipped by overflow: hidden', async ({ page }) => {
        await load(page, '<div id="clip" style="overflow: hidden; margin: 24px; width: max-content"><button type="button" style="width: 100px">Clipped</button></div>');
        await expect(expectRingNotClipped(page.getByRole('button'))).rejects.toThrow(/div#clip cuts 6\.0px off the left/);
    });
});

test.describe('expectNotObscured', () => {
    // Each bar's z-index puts it over the buttons, which come later in the tree and would paint over a bar without one.
    const bottomBar = '<div id="bar" style="position: fixed; left: 0; right: 0; bottom: 0; height: 80px; z-index: 1; background: #222"></div>';
    const bottomBarNoPointer = '<div id="bar" style="position: fixed; left: 0; right: 0; bottom: 0; height: 80px; z-index: 1; pointer-events: none; background: #222"></div>';
    // 800 px viewport minus 300 px paddings leaves 200 px, so a 300 px element is tall.
    const tallPage = 'html { scroll-padding: 300px 0; }';
    const tall = '<button type="button" style="position: absolute; top: 60px; left: 100px; width: 200px; height: 300px">Tall</button>';
    const topBar = (height: number) => `<div id="bar" style="position: fixed; left: 0; right: 0; top: 0; height: ${height}px; z-index: 1; background: #222"></div>`;

    test('passes a short element clear of a fixed bar', async ({ page }) => {
        await load(page, `${bottomBar}<button type="button" style="position: absolute; top: 100px; left: 100px">Clear</button>`);
        await expectNotObscured(page.getByRole('button'), page.locator('#bar'));
    });

    test('fails a short element whose ring a fixed bar partly covers', async ({ page }) => {
        await load(page, `${bottomBar}<button type="button" style="position: absolute; top: 740px; left: 100px">Covered</button>`);
        await expect(expectNotObscured(page.getByRole('button'), page.locator('#bar'))).rejects.toThrow(/fits between the scroll paddings, so its focus ring must be fully clear/);
    });

    test('passes a short element that paints over the fixed bar where they meet', async ({ page }) => {
        await load(page, `${bottomBar}<button type="button" style="position: absolute; top: 740px; left: 100px; z-index: 2">Over</button>`);
        await expectNotObscured(page.getByRole('button'), page.locator('#bar'));
    });

    test('fails a short element under a fixed bar that takes no pointer', async ({ page }) => {
        await load(page, `${bottomBarNoPointer}<button type="button" style="position: absolute; top: 740px; left: 100px">Covered</button>`);
        await expect(expectNotObscured(page.getByRole('button'), page.locator('#bar'))).rejects.toThrow(/fits between the scroll paddings, so its focus ring must be fully clear/);
    });

    test('passes a short element that paints over a fixed bar that takes no pointer, and puts the styles back', async ({ page }) => {
        // Without pointer events the hit test can't place the bar, so it would count as a cover.
        await load(page, `${bottomBarNoPointer}<button type="button" style="position: absolute; top: 740px; left: 100px; z-index: 2">Over</button>`);
        const styles = () => page.locator('#bar, button').evaluateAll((elements) => elements.map((el) => el.getAttribute('style')));
        const before = await styles();
        await expectNotObscured(page.getByRole('button'), page.locator('#bar'));
        expect(await styles()).toEqual(before);
        await expect(page.locator('#bar')).toHaveCSS('pointer-events', 'none');
    });

    test('fails chrome that paints beneath the element at one point and over it at another', async ({ page }) => {
        // The chrome has no stacking context of its own, so its children stack with the button: #under (z-index 0)
        // beneath all of it, #over (z-index 2) on its bottom right grid cell. The first grid point sees only #under.
        await load(page, `
            <div id="chrome" style="position: absolute; top: 0; left: 0; width: 400px; height: 400px">
                <div id="under" style="position: absolute; inset: 0; z-index: 0; background: #ccc"></div>
                <div id="over" style="position: absolute; top: 140px; left: 180px; width: 20px; height: 10px; z-index: 2; background: #222"></div>
            </div>
            <button type="button" style="position: absolute; top: 100px; left: 100px; width: 100px; height: 50px; z-index: 1">Mixed</button>`);
        await expect(expectNotObscured(page.getByRole('button'), page.locator('#chrome'))).rejects.toThrow(/fits between the scroll paddings, so its focus ring must be fully clear/);
        // With #over gone, the chrome paints beneath the button everywhere they meet.
        await page.locator('#over').evaluate((el) => el.remove());
        await expectNotObscured(page.getByRole('button'), page.locator('#chrome'));
    });

    test('fails a short element when a fixed bar covers only the outer 2 px of its ring', async ({ page }) => {
        // The ring reaches 6 px above the button's top edge at 100 px, to 94 px, and the bar ends at 96 px.
        await load(page, `${topBar(96)}<button type="button" style="position: absolute; top: 100px; left: 100px">Covered</button>`);
        await expect(expectNotObscured(page.getByRole('button'), page.locator('#bar'))).rejects.toThrow(/fits between the scroll paddings, so its focus ring must be fully clear/);
    });

    test('passes a tall element whose ring a fixed bar partly covers', async ({ page }) => {
        await load(page, `${topBar(200)}${tall}`, tallPage);
        await expectNotObscured(page.getByRole('button'), page.locator('#bar'));
    });

    test('fails a tall element whose ring a fixed bar hides entirely', async ({ page }) => {
        await load(page, `${topBar(450)}${tall}`, tallPage);
        await expect(expectNotObscured(page.getByRole('button'), page.locator('#bar'))).rejects.toThrow(/may cover part of its focus ring but not hide it entirely/);
    });

    test('ignores chrome that contains the element', async ({ page }) => {
        await load(page, `
            <nav id="bar" aria-label="Primary" style="position: fixed; left: 0; right: 0; bottom: 0; height: 80px; padding: 0 16px; display: flex; align-items: center; background: #222">
                <a href="#home" style="display: inline-flex; align-items: center; min-width: 44px; min-height: 44px; color: #fff">Home</a>
            </nav>`);
        await expectNotObscured(page.getByRole('link'), page.locator('#bar'));
    });

    // A 200 px circle at the top left, scaled from 400 px the way the portrait is, over a button near its box's bottom right corner.
    const circle = '<div id="round" style="position: fixed; top: 0; left: 0; width: 400px; height: 400px; border-radius: 9999px; background: #222; transform: scale(0.5); transform-origin: 0 0; z-index: 1"></div>';
    const nearCorner = (at: number) => `<button type="button" style="position: absolute; top: ${at}px; left: ${at}px">Near</button>`;

    test("passes a short element whose ring meets a round cover's box but not its curve", async ({ page }) => {
        // The ring's top left corner at 178 px sits 110 px from the circle's centre at 100 px, past its 100 px radius.
        await load(page, `${circle}${nearCorner(184)}`);
        await expectNotObscured(page.getByRole('button'), page.locator('#round'));
    });

    test("fails a short element whose ring a round cover's curve reaches", async ({ page }) => {
        // The ring's top left corner at 158 px sits 82 px from the circle's centre.
        await load(page, `${circle}${nearCorner(164)}`);
        await expect(expectNotObscured(page.getByRole('button'), page.locator('#round'))).rejects.toThrow(/ring samples under div/);
    });

    test('takes rounded-full on a tall box as a capsule, which reaches wider than an ellipse in the same box', async ({ page }) => {
        // 200 by 300: half circles of 100 px radius centred 100 and 200 px down, joined by straight sides.
        const capsule = '<div id="round" style="position: fixed; top: 0; left: 0; width: 200px; height: 300px; border-radius: 9999px; background: #222; z-index: 1"></div>';
        const beside = (left: number) => `<button type="button" style="position: absolute; top: 28px; left: ${left}px">Beside</button>`;
        // A ring from 190 px across reaches 78 px down, 93 px from the top centre: inside the capsule, outside the ellipse.
        await load(page, `${capsule}${beside(196)}`);
        await expect(expectNotObscured(page.getByRole('button'), page.locator('#round'))).rejects.toThrow(/ring samples under div/);
        // From 200 px across it clears the curve.
        await load(page, `${capsule}${beside(206)}`);
        await expectNotObscured(page.getByRole('button'), page.locator('#round'));
    });

    // A 100 px square at the top left. Its shadows decide how far past the box it paints.
    const square = (shadow: string) =>
        `<div id="square" style="position: fixed; top: 0; left: 0; width: 100px; height: 100px; background: #222; box-shadow: ${shadow}; z-index: 1"></div>`;
    const rightOf = (left: number) => `<button type="button" style="position: absolute; top: 40px; left: ${left}px">Beside</button>`;

    test('counts a solid shadow band as cover, as a ring-4 paints one', async ({ page }) => {
        // The band paints to 108 px across. A ring from 106 px reaches into it, and one from 110 px clears it.
        await load(page, `${square('0 0 0 8px #222')}${rightOf(112)}`);
        await expect(expectNotObscured(page.getByRole('button'), page.locator('#square'))).rejects.toThrow(/ring samples under div/);
        await load(page, `${square('0 0 0 8px #222')}${rightOf(116)}`);
        await expectNotObscured(page.getByRole('button'), page.locator('#square'));
    });

    test('ignores an inset, blurred, or transparent shadow', async ({ page }) => {
        await load(page, `${square('inset 0 0 0 20px #000, 0 0 12px 20px rgba(0, 0, 0, 0.5), 0 0 0 20px transparent')}${rightOf(112)}`);
        await expectNotObscured(page.getByRole('button'), page.locator('#square'));
    });

    test('grows a round cover by its band, scaled as the cover is', async ({ page }) => {
        // The 20 px band on the half-scale circle is 10 px on screen, so its radius reaches 110 px from the centre at
        // 100 px. A ring corner at 174 px sits 104.7 px from it: clear of the circle, under the band.
        const banded = circle.replace('background: #222;', 'background: #222; box-shadow: 0 0 0 20px #222;');
        await load(page, `${banded}${nearCorner(180)}`);
        await expect(expectNotObscured(page.getByRole('button'), page.locator('#round'))).rejects.toThrow(/ring samples under div/);
        await load(page, `${circle}${nearCorner(180)}`);
        await expectNotObscured(page.getByRole('button'), page.locator('#round'));
    });
});

test.describe('expectTabOrderMatchesVisualOrder', () => {
    const grid = (flow: string, buttons: string) =>
        `<div style="display: grid; grid-template-columns: repeat(3, 100px); grid-auto-flow: ${flow}; gap: 8px; padding: 24px">${buttons}</div>`;
    const spans = '<button type="button" style="grid-column: span 2">A</button><button type="button" style="grid-column: span 2">B</button><button type="button">C</button>';

    test('passes a grid in DOM order', async ({ page }) => {
        await load(page, grid('row', spans));
        await expectTabOrderMatchesVisualOrder(page, page.getByRole('button'));
    });

    test('fails a dense grid', async ({ page }) => {
        await load(page, grid('dense', spans));
        await expect(expectTabOrderMatchesVisualOrder(page, page.getByRole('button'))).rejects.toThrow(/Row-major visual order/);
    });

    test('fails when tabindex reorders Tab', async ({ page }) => {
        await load(page, grid('row', '<button type="button" tabindex="2">A</button><button type="button" tabindex="1">B</button><button type="button">C</button>'));
        await expect(expectTabOrderMatchesVisualOrder(page, page.getByRole('button'))).rejects.toThrow(/Tab order through/);
    });
});

test.describe('expectReachableWithin', () => {
    const buttons = (count: number) =>
        Array.from({ length: count }, (_, i) => `<button type="button"${i === count - 1 ? ' id="target"' : ''}>Stop ${i + 1}</button>`).join('');

    test('passes a target 3 stops deep with limit 3', async ({ page }) => {
        await load(page, buttons(3));
        await expectReachableWithin(page, page.locator('#target'), 3);
    });

    test('fails a target 5 stops deep with limit 3', async ({ page }) => {
        await load(page, buttons(5));
        await expect(expectReachableWithin(page, page.locator('#target'), 3)).rejects.toThrow(/reachable within 3 Tab presses/);
    });
});

test.describe('expectUniqueNames', () => {
    test('passes distinct names', async ({ page }) => {
        await load(page, '<button type="button" aria-label="Photograph 1 of 2"></button><button type="button" aria-label="Photograph 2 of 2"></button>');
        await expectUniqueNames([page.getByRole('button')]);
    });

    test('fails duplicate names', async ({ page }) => {
        await load(page, '<button type="button" aria-label="Photograph 1 of 2"></button><button type="button" aria-label="Photograph 1 of 2"></button>');
        await expect(expectUniqueNames([page.getByRole('button')])).rejects.toThrow(/2 elements share the name Photograph 1 of 2/);
    });

    test('fails a missing name', async ({ page }) => {
        await load(page, '<button type="button"></button>');
        await expect(expectUniqueNames([page.getByRole('button')])).rejects.toThrow(/has no name of its own/);
    });

    test('fails a name that sits on a child, not the focusable element', async ({ page }) => {
        await load(page, '<div id="tile" tabindex="0"><img alt="Fixture Camera" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></div>');
        await expect(expectUniqueNames([page.locator('#tile')])).rejects.toThrow(/has no name of its own/);
    });
});

test.describe('expectContrastOverImage', () => {
    test('passes white text on black', async ({ page }) => {
        await load(page, '<p id="caption" style="margin: 0; padding: 8px; background: #000; color: #fff">Caption</p>');
        expect(await expectContrastOverImage(page.locator('#caption'), { min: 4.5 })).toBeCloseTo(21, 1);
    });

    test('passes a currentColor icon on black, so it hides icons before sampling', async ({ page }) => {
        await load(page, `
            <div style="padding: 8px; width: max-content; background: #000">
                <svg id="icon" style="display: block; color: #fff" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
            </div>`);
        expect(await expectContrastOverImage(page.locator('#icon'), { min: 3 })).toBeCloseTo(21, 1);
    });

    test('fails white text on white', async ({ page }) => {
        await load(page, '<p id="caption" style="margin: 0; padding: 8px; background: #fff; color: #fff">Caption</p>');
        await expect(expectContrastOverImage(page.locator('#caption'), { min: 4.5 })).rejects.toThrow(/Worst contrast/);
    });

    test('measures the settled state of a parent that is still fading in', async ({ page }) => {
        await load(page, '<div id="wrap" style="padding: 8px; background: #000; opacity: 0.2; transition: opacity 60s"><p id="caption" style="margin: 0; color: #fff">Caption</p></div>');
        // Starts a 60 s fade to full opacity. Read before the screenshot, the opacity would still be about 0.2.
        await page.locator('#wrap').evaluate((el: HTMLElement) => {
            el.style.opacity = '1';
        });
        expect(await expectContrastOverImage(page.locator('#caption'), { min: 4.5 })).toBeCloseTo(21, 1);
    });

    test('fails white text at opacity 0.3 on black, so it counts opacity', async ({ page }) => {
        await load(page, '<div style="padding: 8px; background: #000"><p id="caption" style="margin: 0; color: #fff; opacity: 0.3">Caption</p></div>');
        await expect(expectContrastOverImage(page.locator('#caption'), { min: 4.5 })).rejects.toThrow(/Worst contrast/);
    });
});

test.describe('expectReflow', () => {
    test('passes a control that fits 320 px, and restores the page', async ({ page }) => {
        await load(page, '<button type="button" style="width: 200px">Fits</button>');
        await expectReflow(page.getByRole('button'));
        expect(page.viewportSize()).toEqual({ width: 1280, height: 800 });
        expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('');
    });

    test('fails a 400 px control at 320 px', async ({ page }) => {
        await load(page, '<button type="button" style="width: 400px">Too wide</button>');
        await expect(expectReflow(page.getByRole('button'))).rejects.toThrow(/extends past the viewport: right edge at 400\.0 of 320/);
    });

    test('fails controls that overlap', async ({ page }) => {
        await load(page, `
            <button type="button" style="position: fixed; top: 8px; left: 8px; width: 120px">A</button>
            <button type="button" style="position: fixed; top: 8px; left: 60px; width: 120px">B</button>`);
        await expect(expectReflow(page.getByRole('button'))).rejects.toThrow(/overlaps/);
    });
});

test.describe('expectHoverRulesGated', () => {
    const tile = '<button type="button" class="tile">Photo</button>';
    const gated = (rule: string) => `@media (hover: hover) and (pointer: fine) { ${rule} }`;

    test('passes a hover rule inside the gate', async ({ page }) => {
        await load(page, tile, gated('.tile:hover { transform: scale(1.1); }'));
        await expectHoverRulesGated(page);
    });

    test('ignores an ungated hover rule that matches nothing on the page', async ({ page }) => {
        await load(page, tile, '.ghost:hover { transform: scale(1.1); }');
        await expectHoverRulesGated(page);
    });

    test("ignores YARL's own hover rule", async ({ page }) => {
        await load(page, '<button type="button" class="yarl__button">Next</button>', '@media (hover:hover){.yarl__button:focus-visible:hover,.yarl__button:focus:hover,.yarl__button:hover{color:#fff}}');
        await expectHoverRulesGated(page);
    });

    test('fails an ungated hover rule that matches markup', async ({ page }) => {
        await load(page, tile, '.tile:hover { transform: scale(1.1); }');
        await expect(expectHoverRulesGated(page)).rejects.toThrow(/\.tile:hover/);
    });

    test('fails a hover rule gated by (hover: hover) alone', async ({ page }) => {
        await load(page, tile, '@media (hover: hover) { .tile:hover { transform: scale(1.1); } }');
        await expect(expectHoverRulesGated(page)).rejects.toThrow(/\.tile:hover/);
    });

    test('fails an ungated rule whose class name escapes :hover, like a dark:hover: utility', async ({ page }) => {
        // Stripping every :hover would also cut the escaped one and leave .dark\\:lift, which matches nothing.
        await load(page, '<button type="button" class="dark:hover:lift">Photo</button>', '.dark\\:hover\\:lift:hover { transform: scale(1.1); }');
        await expect(expectHoverRulesGated(page)).rejects.toThrow(/dark\\+:hover\\+:lift:hover/);
    });
});

test.describe('expectSingleTapActivates', () => {
    test.use({ hasTouch: true });

    test('passes a button that activates on the first tap', async ({ page }) => {
        await load(page, `<button type="button" onclick="this.dataset.activated = 'true'">Open</button>`);
        const button = page.getByRole('button');
        await expectSingleTapActivates(button, () => expect(button, 'One tap should activate').toHaveAttribute('data-activated', 'true'));
    });

    test('fails a button whose first tap only reveals it', async ({ page }) => {
        await load(page, `<button type="button" onclick="if (this.dataset.revealed) this.dataset.activated = 'true'; else this.dataset.revealed = 'true'">Open</button>`);
        const button = page.getByRole('button');
        await expect(
            expectSingleTapActivates(button, () => expect(button, 'One tap should activate').toHaveAttribute('data-activated', 'true', { timeout: 1000 })),
        ).rejects.toThrow(/One tap should activate/);
        // The tap landed: it revealed the button without activating it.
        await expect(button).toHaveAttribute('data-revealed', 'true');
    });
});

test.describe('checkSurface', () => {
    const SURFACE_STYLE = `
        header { position: fixed; top: 0; left: 0; right: 0; height: 64px; background: #111; }
        nav { display: flex; gap: 8px; padding: 10px 16px; }
        nav a { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; color: #fff; }
        .entries { display: grid; grid-template-columns: repeat(3, 120px); gap: 16px; padding: 120px 24px 24px; }
        .entries button { height: 80px; }
    `;
    const NAMES = ['Photograph 1 of 4', 'Photograph 2 of 4', 'Photograph 3 of 4', 'Photograph 4 of 4'];

    async function loadSurface(page: Page, { names = NAMES, style = '' }: { names?: string[]; style?: string } = {}) {
        const entries = names.map((name) => `<button type="button"${name ? ` aria-label="${name}"` : ''}></button>`).join('');
        await load(page, `<header><nav aria-label="Primary"><a href="#home">Home</a><a href="#about">About</a></nav></header><div class="entries">${entries}</div>`, SURFACE_STYLE + style);
        return {
            entries: page.locator('.entries > button'),
            controls: [page.getByRole('navigation', { name: 'Primary' }).getByRole('link')],
            chrome: [page.locator('header')],
        };
    }

    test('passes a surface that meets every rule', async ({ page }) => {
        await checkSurface(page, await loadSurface(page));
    });

    test('waits for entries that arrive after hydration before it runs axe', async ({ page }) => {
        // Like the gallery's tiles, which mount once /api/photos answers. These carry an img with no alt.
        const image = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">';
        const late = NAMES.map((name) => `<button type="button" aria-label="${name}">${image}</button>`).join('');
        await load(page, `<div class="entries"></div><script>setTimeout(() => { document.querySelector('.entries').innerHTML = '${late}'; }, 300);</script>`, SURFACE_STYLE);
        await expect(checkSurface(page, { entries: page.locator('.entries > button') })).rejects.toThrow(/image-alt/);
    });

    const broken: { title: string; names?: string[]; style?: string; error: RegExp }[] = [
        { title: 'an entry with no name, through axe', names: ['Photograph 1 of 4', '', 'Photograph 3 of 4', 'Photograph 4 of 4'], error: /button-name/ },
        { title: 'a dense entry grid', style: '.entries { grid-auto-flow: dense; } .entries button:nth-child(-n+2) { grid-column: span 2; }', error: /Row-major visual order/ },
        { title: 'a 30 px entry', style: '.entries button:first-child { width: 30px; height: 30px; min-width: 0; min-height: 0; }', error: /is 30\.0 by 30\.0/ },
        { title: 'an entry with outline: none', style: '.entries button:first-child:focus-visible { outline: none; }', error: /outline-style is none/ },
        { title: 'entries clipped by an overflow: hidden grid', style: '.entries { overflow: hidden; padding: 0; margin: 120px 24px 24px; }', error: /cuts 6\.0px off the left/ },
        { title: 'an entry under the fixed header', style: '.entries { padding-top: 24px; }', error: /must be fully clear/ },
        { title: 'duplicate entry names', names: ['Photograph 1 of 4', 'Photograph 1 of 4', 'Photograph 3 of 4', 'Photograph 4 of 4'], error: /2 elements share the name Photograph 1 of 4/ },
    ];
    for (const { title, names, style, error } of broken) {
        test(`fails ${title}`, async ({ page }) => {
            await expect(checkSurface(page, await loadSurface(page, { names, style }))).rejects.toThrow(error);
        });
    }
});

test.describe('recordDispatchedEvents', () => {
    // A stand-in for React DOM's queue. While `queueing`, it keeps the latest native hover of each type and stops it, as
    // queueIfContinuousEvent does, and replays it as attemptReplayContinuousQueuedEvent does: `new event.constructor(type,
    // event)` on the event's own target. With `queueing` off it still keeps the hover but lets it through, as hydrated React does.
    const PAGE = `<!doctype html>
<html lang="en" data-hydrated="true">
<head><meta charset="utf-8"><title>Helper self-test</title></head>
<body style="margin: 0">
<div id="a" style="position: fixed; left: 0; top: 0; width: 200px; height: 200px"></div>
<div id="b" style="position: fixed; left: 300px; top: 0; width: 200px; height: 200px"></div>
<script>
    window.held = {};
    window.queueing = true;
    for (const type of ['mouseover', 'pointerover']) {
        document.addEventListener(type, (e) => {
            if (!e.isTrusted) return;
            held[type] = e;
            if (queueing) e.stopPropagation();
        }, true);
    }
    window.replay = (event, target = event.target) => target.dispatchEvent(new event.constructor(event.type, event));
</script>
</body>
</html>`;

    type StandIn = { held: Record<string, MouseEvent>; replay: (event: Event, target?: EventTarget) => boolean; first: Event; queueing: boolean };

    /** Opens the stand-in with a native hover on #a held. The route answers in the browser, so no server sees it. */
    async function open(page: Page) {
        const dispatched = await recordDispatchedEvents(page);
        await page.route('**/dispatch-self-test', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
        await page.goto('/dispatch-self-test');
        await page.mouse.move(100, 100);
        await expect.poll(() => page.evaluate(() => Object.keys((window as unknown as StandIn).held).sort())).toEqual(['mouseover', 'pointerover']);
        return dispatched;
    }

    test("leaves out React's copy of a native hover on its own target, once", async ({ page }) => {
        const dispatched = await open(page);
        await page.evaluate(() => {
            const { held, replay } = window as unknown as StandIn;
            replay(held.mouseover);
            replay(held.pointerover);
        });
        expect(await dispatched()).toEqual({ synthetic: [], replayed: ['mouseover', 'pointerover'] });

        await page.evaluate(() => {
            const { held, replay } = window as unknown as StandIn;
            replay(held.mouseover);
        });
        expect(await dispatched()).toEqual({ synthetic: ['mouseover'], replayed: ['mouseover', 'pointerover'] });
    });

    test('counts a fresh hover, a copy on another target or at another point, a click, a copy after the pointer left, and a copy of a hover React let through', async ({ page }) => {
        const dispatched = await open(page);
        await page.evaluate(() => {
            const { held, replay } = window as unknown as StandIn;
            const a = document.getElementById('a')!;
            a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            replay(held.mouseover, document.getElementById('b')!);
            // Every field the copy takes from the native hover, with only the point moved.
            const native = held.mouseover;
            a.dispatchEvent(new MouseEvent('mouseover', {
                bubbles: native.bubbles, cancelable: native.cancelable, view: window, relatedTarget: native.relatedTarget,
                screenX: native.screenX, screenY: native.screenY, clientX: native.clientX + 5, clientY: native.clientY,
            }));
            a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            (window as unknown as StandIn).first = held.pointerover;
        });
        expect(await dispatched()).toEqual({ synthetic: ['mouseover', 'mouseover', 'mouseover', 'click'], replayed: [] });

        // Parked, the pointer leaves #a for nothing, so #a's native pointerout drops its pointerover and no new hover takes its place.
        await parkPointer(page);
        await page.evaluate(() => {
            const { first, replay } = window as unknown as StandIn;
            replay(first);
        });
        expect(await dispatched()).toEqual({ synthetic: ['mouseover', 'mouseover', 'mouseover', 'click', 'pointerover'], replayed: [] });

        // A hover React didn't stop reaches window, so it was never queued, and a copy of it is synthetic.
        await page.evaluate(() => ((window as unknown as StandIn).queueing = false));
        await page.mouse.move(100, 100);
        await page.evaluate(() => {
            const { held, replay } = window as unknown as StandIn;
            replay(held.mouseover);
        });
        expect(await dispatched()).toEqual({ synthetic: ['mouseover', 'mouseover', 'mouseover', 'click', 'pointerover', 'mouseover'], replayed: [] });
    });
});

test.describe('parkPointer', () => {
    test('leaves no element under the pointer, so content changing where it rests sends no native hover', async ({ page }) => {
        await load(page, `<div id="frame" style="position: fixed; inset: 0"><div id="a" style="height: 100%"></div></div>
<script>
    window.overs = [];
    window.addEventListener('pointerover', (e) => { if (e.isTrusted) overs.push(e.target.id); }, true);
    window.swap = (id) => { document.getElementById('frame').innerHTML = '<div id="' + id + '" style="height: 100%"></div>'; };
</script>`);
        type Probe = { overs: string[]; swap: (id: string) => void };
        const hovered = () => page.evaluate(() => Array.from(document.querySelectorAll(':hover'), (el) => el.id || el.localName));
        const overs = () => page.evaluate(() => (window as unknown as Probe).overs.splice(0));
        const swap = (id: string) => page.evaluate((next) => (window as unknown as Probe).swap(next), id);

        // Resting on the page, the pointer gets a native hover when new content arrives under it.
        await page.mouse.move(500, 300);
        expect(await overs()).toEqual(['a']);
        await swap('b');
        await expect.poll(overs).toEqual(['b']);

        await parkPointer(page);
        expect(await hovered()).toEqual([]);
        await swap('c');
        // Two frames and then some, for the hover update Chromium runs after layout.
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300)))));
        expect(await overs()).toEqual([]);
        expect(await hovered()).toEqual([]);
    });
});
