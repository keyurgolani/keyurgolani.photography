/**
 * e2e/support/hydration.ts's last wait, run in the page by waitForFunction, so it takes nothing from outside itself:
 * every form at the submit gate (components/site/submitGateScript.ts) says it's ready. On an Inbox URL the Inbox comes
 * first: it streams in after the shell, so until a gated form is there or its loading state has gone, there's nothing
 * yet to wait for, and the page isn't ready.
 */
export function pageReady(): boolean {
    const forms = [...document.querySelectorAll('form[data-submit-gate]')];
    if (window.location.pathname.startsWith('/curation/inbox') && forms.length === 0) {
        const loading = [...document.querySelectorAll('[role="status"]')].some((element) => (element.textContent ?? '').includes('Loading the inbox'));
        if (loading) return false;
    }
    return forms.every((form) => form.getAttribute('data-submit-gate') === 'ready');
}
