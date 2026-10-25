import { describe, expect, it } from 'vitest';
import { isViewerPath, stepForKey, type StepKey } from '../viewerKeys';

function key(name: string, modifiers: Partial<Pick<StepKey, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {}, target: EventTarget | null = document.body): StepKey {
    return { key: name, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target, ...modifiers };
}

describe('stepForKey', () => {
    it('moves with Left and Right, and nothing else', () => {
        expect(stepForKey(key('ArrowLeft'), false)).toBe('previous');
        expect(stepForKey(key('ArrowRight'), false)).toBe('next');
        for (const other of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ', 'Escape', 'Left', 'Right', 'PageDown']) {
            expect(stepForKey(key(other), false), other).toBeNull();
        }
    });

    it('leaves an arrow held with any modifier to its owner: Alt+Left is the browser\'s Back', () => {
        for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
            expect(stepForKey(key('ArrowLeft', { [modifier]: true }), false), modifier).toBeNull();
            expect(stepForKey(key('ArrowRight', { [modifier]: true }), false), modifier).toBeNull();
        }
    });

    it('never moves while the photograph is zoomed, since its scroll region owns the arrows', () => {
        expect(stepForKey(key('ArrowLeft'), true)).toBeNull();
        expect(stepForKey(key('ArrowRight'), true)).toBeNull();
    });

    it('leaves the caret keys to form fields and editable text, inside them too', () => {
        document.body.innerHTML = `
            <input id="text" /><textarea id="area"></textarea><select id="pick"><option>a</option></select>
            <div contenteditable="true"><span id="inside">x</span></div>
            <div contenteditable="false"><span id="readonly">x</span></div>
            <button id="button" type="button">b</button>`;
        for (const id of ['text', 'area', 'pick', 'inside']) {
            expect(stepForKey(key('ArrowRight', {}, document.getElementById(id)), false), id).toBeNull();
        }
        // A button, the body, an element that isn't editable, or no element at all still move.
        for (const id of ['button', 'readonly']) {
            expect(stepForKey(key('ArrowRight', {}, document.getElementById(id)), false), id).toBe('next');
        }
        expect(stepForKey(key('ArrowLeft', {}, document), false)).toBe('previous');
        expect(stepForKey(key('ArrowLeft', {}, null), false)).toBe('previous');
        document.body.innerHTML = '';
    });
});

describe('isViewerPath', () => {
    it('matches /work/<slug>/photo/<photoId> only', () => {
        expect(isViewerPath('/work/harbor/photo/ph_1')).toBe(true);
        expect(isViewerPath('/work/harbor/photo/ph_1/')).toBe(true);
        for (const path of ['/work/harbor', '/work/harbor/', '/work', '/work/harbor/photo', '/work/harbor/photo/', '/work/a/photo/b/c', '/gallery', '/x/work/a/photo/b', null]) {
            expect(isViewerPath(path), String(path)).toBe(false);
        }
    });
});
