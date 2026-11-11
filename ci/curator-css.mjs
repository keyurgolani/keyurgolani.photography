/**
 * The curator CSS guard: no visitor route's first-load CSS carries a stylesheet from app/curation/. themes-budget.mjs
 * runs it on the head tree, over the same files and inline sheet its budget sums for each route, so the two agree on
 * what a route loads.
 *
 * Which module a rule came from: Turbopack's production CSS has no comments and no source maps, and its chunks merge
 * modules from many routes (#237's Inbox note rode in the chunk Home, Work and About share), so neither a chunk's name
 * nor the manifest entry that lists it says what's inside. Every CSS module's class map does: Turbopack names each
 * class `<module hash>_<name>`, and the server chunks' source maps keep each module's map as the source
 * `turbopack:///[project]/<path> [<layer>] (css module)`, whose content is `__turbopack_context__.v({ name: "hash_name" })`.
 * A module is in a route's CSS when one of its hashed names is. That signal names the file itself, and the hash makes a
 * false match all but impossible. It fails closed: a curator stylesheet it can't trace (a plain .css file, a module
 * with no class, or one missing from the build's maps, as when server source maps are off) fails the guard by name.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CURATOR_DIR = 'app/curation/';
const SOURCE = /^turbopack:\/\/\/\[project\]\/(.+?\.module\.css) \[[^\]]+\] \(css module\)$/;
const ENTRY = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Each CSS module's hashed class names, from one parsed source map (sectioned or not), by the module's path from the
 * project root. A name's value can list composed classes after its own; only the first, the module's own, is kept.
 */
export function cssModuleClasses(map) {
  const out = new Map();
  for (const part of map.sections ? map.sections.map((section) => section.map) : [map]) {
    (part?.sources ?? []).forEach((source, index) => {
      const module = SOURCE.exec(source)?.[1];
      const content = part.sourcesContent?.[index];
      if (!module || typeof content !== 'string') return;
      const names = out.get(module) ?? new Set();
      for (const [, , value] of content.matchAll(ENTRY)) {
        const own = value.trim().split(/\s+/)[0];
        if (own) names.add(own);
      }
      out.set(module, names);
    });
  }
  return out;
}

/** Every CSS module's class names across a build's server source maps (`<tree>/.next/server/**.js.map`). */
export function readBuildClasses(nextDir) {
  const all = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js.map')) {
        for (const [module, names] of cssModuleClasses(JSON.parse(fs.readFileSync(file, 'utf8')))) {
          const known = all.get(module) ?? new Set();
          for (const name of names) known.add(name);
          all.set(module, known);
        }
      }
    }
  };
  walk(path.join(nextDir, 'server'));
  return all;
}

/** The stylesheets under app/curation/ in a tree's source, from the project root, tests' own left out. */
export function curatorSheets(tree) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(tree, rel), { withFileTypes: true })) {
      const file = `${rel}${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(`${file}/`);
      } else if (entry.name.endsWith('.css')) out.push(file);
    }
  };
  walk(CURATOR_DIR);
  return out.sort();
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The modules, of those in `classes`, one of whose hashed names appears in `css` as a whole name. */
export function modulesInCss(css, classes) {
  const found = [];
  for (const [module, names] of classes) {
    for (const name of names) {
      if (new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`).test(css)) {
        found.push(module);
        break;
      }
    }
  }
  return found.sort();
}

/**
 * The guard's failures, each one line. `routes` is `[{ name, sheets: [{ file, css }] }]`, a visitor route's first-load
 * stylesheets with their text; `classes` the build's class maps; `sources` the stylesheets under app/curation/.
 */
export function curatorCssFindings({ routes, classes, sources }) {
  const failures = [];
  for (const file of sources) {
    if (!file.endsWith('.module.css')) {
      failures.push(`${file} is a plain stylesheet, which this guard can't trace to a route. Make it a CSS module.`);
    } else if (!classes.get(file)?.size) {
      failures.push(`${file} has no class names in the build's server source maps, so this guard can't see where it lands. Give it a class, or remove it if nothing imports it.`);
    }
  }
  const curator = new Map([...classes].filter(([module]) => module.startsWith(CURATOR_DIR)));
  for (const { name, sheets } of routes) {
    for (const { file, css } of sheets) {
      for (const module of modulesInCss(css, curator)) failures.push(`${name} loads ${module}, in ${file}.`);
    }
  }
  return failures;
}
