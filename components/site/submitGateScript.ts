/**
 * Runs in `<head>`, beside THEME_INIT_SCRIPT, before any Next.js script, so it's there before the first press.
 *
 * Some forms post by hand, from a handler React attaches when it hydrates them, and have no plain-post route: the
 * Inbox's bulk form and item forms. Each opts in with `data-submit-gate`, which the server renders `waiting` and the
 * form's own component sets to `ready` once it has mounted (app/curation/inbox/useHydrated.ts). Until then, this drops,
 * silently, anything that would send such a form or change what it would send:
 *
 * - a submit, however it was made: a button press, Enter in a field, or requestSubmit();
 * - a click that would tick a checkbox or a radio of the form, one outside it by `form` included;
 * - typing, pasting or deleting in its fields (`beforeinput`);
 * - a key or a press that would change one of its selects (Tab still moves on).
 *
 * It stops each event where it starts, in the capture phase at the document, so neither the browser's default nor
 * React's replay of an event it saw before hydrating can act on it later. Every other form, and every control that
 * isn't a form's, is never touched. Without JavaScript none of this runs, and the forms are the server's markup alone.
 *
 * Nothing here is shown: the controls look as they will once ready. It sets nothing on the document, and keeps its
 * names off `window`, since a classic script's top-level `var` becomes a global. No policy sends script-src today; the
 * day one does, it must allow this script by the same hash or nonce as THEME_INIT_SCRIPT (__tests__/curatorBoundary).
 */
export const SUBMIT_GATE_ATTRIBUTE = 'data-submit-gate';

export const SUBMIT_GATE_SCRIPT =
    "(function(){try{var d=document,a='data-submit-gate'," +
    "w=function(f){return!!f&&f.nodeType===1&&f.hasAttribute(a)&&f.getAttribute(a)!=='ready'}," +
    "o=function(t){return t&&t.nodeType===1&&t.localName!=='form'&&'form' in t?t.form:null}," +
    "s=function(e){e.preventDefault();e.stopImmediatePropagation()};" +
    "d.addEventListener('submit',function(e){if(w(e.target))s(e)},true);" +
    "d.addEventListener('click',function(e){var t=e.target;if(t&&t.localName==='input'&&(t.type==='checkbox'||t.type==='radio')&&w(o(t)))s(e)},true);" +
    "d.addEventListener('beforeinput',function(e){if(w(o(e.target)))s(e)},true);" +
    "d.addEventListener('keydown',function(e){var t=e.target;if(t&&t.localName==='select'&&e.key!=='Tab'&&w(o(t)))s(e)},true);" +
    "d.addEventListener('mousedown',function(e){var t=e.target;if(t&&t.localName==='select'&&w(o(t)))s(e)},true)" +
    '}catch(e){}})()';
