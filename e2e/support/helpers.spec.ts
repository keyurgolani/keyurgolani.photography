import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './a11y';
import { expectContrastOverImage } from './contrast';
import { expectFocusRingVisible, expectNotObscured, expectRingNotClipped } from './focus';
import { expectHoverRulesGated } from './hover';
import { expectReachableWithin, expectTabOrderMatchesVisualOrder } from './keyboard';
import { expectReflow } from './reflow';
import { checkSurface, expectUniqueNames } from './surface';
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
    const bottomBar = '<div id="bar" style="position: fixed; left: 0; right: 0; bottom: 0; height: 80px; background: #222"></div>';
    // 800 px viewport minus 300 px paddings leaves 200 px, so a 300 px element is tall.
    const tallPage = 'html { scroll-padding: 300px 0; }';
    const tall = '<button type="button" style="position: absolute; top: 60px; left: 100px; width: 200px; height: 300px">Tall</button>';
    const topBar = (height: number) => `<div id="bar" style="position: fixed; left: 0; right: 0; top: 0; height: ${height}px; background: #222"></div>`;

    test('passes a short element clear of a fixed bar', async ({ page }) => {
        await load(page, `${bottomBar}<button type="button" style="position: absolute; top: 100px; left: 100px">Clear</button>`);
        await expectNotObscured(page.getByRole('button'), page.locator('#bar'));
    });

    test('fails a short element whose ring a fixed bar partly covers', async ({ page }) => {
        await load(page, `${bottomBar}<button type="button" style="position: absolute; top: 740px; left: 100px">Covered</button>`);
        await expect(expectNotObscured(page.getByRole('button'), page.locator('#bar'))).rejects.toThrow(/fits between the scroll paddings, so its focus ring must be fully clear/);
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
