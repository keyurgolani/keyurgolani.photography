import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { installMatchMedia } from './test/matchMedia';
import { installDocumentVisibility } from './test/visibility';

// jsdom has no matchMedia and pins visibility, so every DOM test starts with
// motion allowed and the page visible. Node-environment tests have neither.
beforeEach(() => {
    if (typeof window === 'undefined') return;
    installMatchMedia();
    installDocumentVisibility();
});
