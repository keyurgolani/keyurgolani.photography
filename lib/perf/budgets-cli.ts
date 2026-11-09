/**
 * The measuring half of #6's publish warning, as a process of its own:
 * reads `{ content, meta, budgets }` as JSON on stdin and writes
 * measureCatalogBudgets()'s answer as JSON on stdout. catalog-budgets.ts's
 * measureInChild() runs it under `--conditions=react-server`, where
 * `server-only` is empty, since the reader and the projections it measures
 * carry that marker. Nothing imports this file. In the image it's
 * dist/scripts/budgets-cli.mjs, bundled under the same condition
 * (`npm run build:scripts`). It reads nothing from disk and writes nothing.
 */
import { createCatalogReader, type CatalogContent, type ReaderMeta } from '../catalog/reader';
import type { SCREEN_BUDGETS } from './budgets';
import { measureCatalogBudgets } from './measure';

/** One line for the parent to quote: the error's name and first line, with any absolute path cut to its last segment. */
function oneLine(error: unknown): string {
    const name = error instanceof Error ? error.name : 'Error';
    const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    return `budgets-cli: ${name}: ${message.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/:'"()]+){2,}/g, (found) => `…/${found.split(/[\\/]/).pop()}`)}\n`;
}

try {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    const { content, meta, budgets } = JSON.parse(input) as { content: CatalogContent; meta: ReaderMeta; budgets: typeof SCREEN_BUDGETS };
    process.stdout.write(JSON.stringify(measureCatalogBudgets(createCatalogReader(content, meta), { budgets })));
} catch (error) {
    process.stderr.write(oneLine(error));
    process.exitCode = 1;
}
