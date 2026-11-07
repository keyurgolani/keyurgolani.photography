import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

const CSS = postcss.parse(fs.readFileSync(path.join(import.meta.dirname, '../StoryViewer.module.css'), 'utf8'));

/**
 * One rule of StoryViewer.module.css, as the browser would apply it, on the elements `target` matches inside
 * `container`. jsdom applies no CSS module, and an accessible name depends on the display of each part: a part that
 * isn't inline gets a space on each side. The style goes in the rendered container, so it goes with it.
 */
export function applyViewerRule(container: HTMLElement, moduleSelector: string, target: string): void {
    let declarations: string | null = null;
    CSS.walkRules((rule) => {
        if (rule.selector === moduleSelector) declarations = rule.nodes.map(String).join('; ');
    });
    if (declarations === null) throw new Error(`StoryViewer.module.css has no rule for ${moduleSelector}`);
    const style = document.createElement('style');
    style.textContent = `${target} { ${declarations} }`;
    container.append(style);
}
