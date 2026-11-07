/**
 * Runs in `<head>`, beside THEME_INIT_SCRIPT, before any Next.js script, so it's there before the first press.
 *
 * Some forms post by hand, from a handler React attaches when it hydrates them, and have no plain-post route: the
 * Inbox's bulk form and item forms. Each opts in with `data-submit-gate`, which the server renders `waiting` and the
 * form's own component sets to `ready` once it has mounted (app/curation/inbox/useHydrated.ts). Until then, this drops
 * anything that would send such a form or change what it would send, whatever else on the page has hydrated:
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
 * A drop isn't silent: the form is marked `data-submit-dropped`, and one status at the end of <body> says
 * SUBMIT_GATE_STATUS_TEXT. The status is made empty and given its words a moment later, so a screen reader that has
 * seen the region reads them out (role="status", polite). It sits fixed at the foot of the screen and takes no clicks.
 * It's a child of <body>, which React leaves alone when it hydrates, never of a form React owns. Once no marked form
 * is still waiting, the status and the marks go. Nothing is shown while nothing is dropped, so a page no one has
 * pressed early is the server's markup alone.
 *
 * It sets nothing on the document element, and keeps its names off `window`, since a classic script's top-level
 * `var` becomes a global. No policy sends script-src today; the day one does, it must allow this script by the same
 * hash or nonce as THEME_INIT_SCRIPT (__tests__/curatorBoundary).
 */
export const SUBMIT_GATE_ATTRIBUTE = 'data-submit-gate';

/** What the status says after a drop. */
export const SUBMIT_GATE_STATUS_TEXT = 'Still loading. Try again in a moment.';

const STATUS_STYLE =
    'position:fixed;left:1rem;bottom:1rem;z-index:2147483647;margin:0;padding:0.5rem 0.75rem;max-width:calc(100vw - 2rem);' +
    'border:1px solid var(--gah-rule-strong,rgba(255,255,255,0.38));border-radius:var(--gah-radius,4px);' +
    'background:var(--gah-raised,#151917);color:var(--gah-ink,#f4f6f5);font:inherit;pointer-events:none';

export const SUBMIT_GATE_SCRIPT =
    "(function(){try{var d=document,a='data-submit-gate',k='data-submit-dropped',x='data-submit-gate-status',watch=null," +
    `words=${JSON.stringify(SUBMIT_GATE_STATUS_TEXT)},look=${JSON.stringify(STATUS_STYLE)},` +
    "w=function(f){return!!f&&f.nodeType===1&&f.hasAttribute(a)&&f.getAttribute(a)!=='ready'}," +
    "o=function(t){return t&&t.nodeType===1&&t.localName!=='form'&&'form' in t?t.form:null}," +
    "gone=function(){var s=d.querySelector('['+x+']'),m=d.querySelectorAll('form['+k+']'),i;if(s)s.remove();for(i=0;i<m.length;i++)m[i].removeAttribute(k);if(watch){watch.disconnect();watch=null}}," +
    "check=function(){if(!d.querySelector('form['+k+']:not(['+a+'=ready])'))gone()}," +
    "say=function(f){f.setAttribute(k,'true');var s=d.querySelector('['+x+']');if(!s&&d.body){s=d.createElement('p');s.setAttribute(x,'');s.setAttribute('role','status');s.style.cssText=look;d.body.appendChild(s);" +
    "setTimeout(function(){s.textContent=words},100)}if(!watch&&window.MutationObserver){watch=new MutationObserver(check);watch.observe(d.documentElement,{subtree:true,attributes:true,attributeFilter:[a]})}}," +
    "s=function(e,f){e.preventDefault();e.stopImmediatePropagation();say(f)};" +
    "d.addEventListener('submit',function(e){if(w(e.target))s(e,e.target)},true);" +
    "d.addEventListener('click',function(e){var t=e.target,f=o(t);if(t&&t.localName==='input'&&(t.type==='checkbox'||t.type==='radio')&&w(f))s(e,f)},true);" +
    "d.addEventListener('beforeinput',function(e){var f=o(e.target);if(w(f))s(e,f)},true);" +
    "d.addEventListener('keydown',function(e){var t=e.target,f=o(t);if(t&&t.localName==='select'&&e.key!=='Tab'&&w(f))s(e,f)},true);" +
    "d.addEventListener('mousedown',function(e){var t=e.target,f=o(t);if(t&&t.localName==='select'&&w(f))s(e,f)},true)" +
    '}catch(e){}})()';
