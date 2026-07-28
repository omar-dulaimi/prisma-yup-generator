#!/usr/bin/env node
'use strict';

/**
 * Checks the README's TypeScript examples against the schemas this generator really emits.
 *
 * The published README told people to import `PostCreateOneSchema`, a name this generator
 * has never emitted, and to validate a bare request body against a schema that expects
 * Prisma's `{ data: ... }` argument. Both mistakes only show up when you run the example,
 * and nothing ran it, so the first thing a new user copied out of the README threw.
 *
 * Two passes, because the two mistakes fail differently:
 *
 *   1. Resolve every name the README imports through the emitted module graph, following
 *      `export * from` / `export { x } from` exactly as an `import` would. A name that is
 *      emitted somewhere in the output but not reachable from the documented entry point
 *      still fails, because that is what a reader copying the example would hit.
 *   2. Execute the example. Wrong names and wrong argument shapes both throw at runtime,
 *      and only running it proves the documented snippet works end to end.
 *
 * It deliberately does not typecheck the emitted schemas. That output still needs its
 * `// @ts-nocheck` header to compile (see issue #14, and the note on the verify job in
 * ci.yml for what is left), so typechecking it here would be red and would say nothing
 * about whether the README is honest.
 *
 * Usage: node scripts/check-readme-example.js [project-root] [readme]
 *
 *   project-root  directory the README's relative import paths resolve against, i.e. the
 *                 one holding the emitted output (default: the repo root, which is where
 *                 `npm run gen-example` puts it)
 *   readme        README to check (default: <repo root>/README.md)
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const repoRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(process.argv[2] || repoRoot);
const readmePath = path.resolve(
  process.argv[3] || path.join(repoRoot, 'README.md'),
);

/**
 * Request body handed to the route the README example registers. It matches the `Post`
 * model in the README's own example schema. If you change the example to a different
 * model, change this to match, or pass 2 will fail on a body the schema rightly rejects.
 */
const SAMPLE_BODY = {
  title: 'Hello world',
  content: 'first post',
  published: true,
};

const failures = [];
const notes = [];

/** Every ```ts / ```tsx / ```typescript fenced block in the README. */
function tsCodeBlocks(markdown) {
  const blocks = [];
  const fence = /^```(?:ts|tsx|typescript)\s*$\n([\s\S]*?)^```\s*$/gm;
  let match;
  while ((match = fence.exec(markdown)) !== null) blocks.push(match[1]);
  return blocks;
}

/** `import { A, B as C } from './x'` -> { names: ['A', 'B'], from: './x' } */
function namedImports(code) {
  const imports = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    const names = match[1]
      .split(',')
      .map((entry) =>
        entry
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    imports.push({ names, from: match[2] });
  }
  return imports;
}

/** Resolve a module specifier to a file, the way the emitted code expects. */
function resolveModule(specifier) {
  const candidates = [
    `${specifier}.ts`,
    path.join(specifier, 'index.ts'),
    specifier, // the emitted code sometimes writes the extension out in full
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      return candidate;
  }
  return null;
}

/** Names an `import` from `entry` can actually bind, following re-exports. */
function reachableExports(entry) {
  const found = new Set();
  const seen = new Set();
  const queue = [entry];

  const addClause = (clause) => {
    for (const item of clause.replace(/^\{|\}$/g, '').split(',')) {
      const parts = item.trim().split(/\s+as\s+/);
      const exported = (parts[1] || parts[0] || '').trim();
      if (exported) found.add(exported);
    }
  };

  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    const source = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);

    for (const match of source.matchAll(
      /export\s+(?:declare\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      found.add(match[1]);
    }

    for (const match of source.matchAll(/export\s*(\{[^}]*\})\s*(?!from)/g))
      addClause(match[1]);

    for (const match of source.matchAll(
      /export\s+(\*|\{[^}]*\})\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s*['"]([^'"]+)['"]/g,
    )) {
      const resolved = resolveModule(path.resolve(dir, match[2]));
      if (!resolved) {
        notes.push(
          `unresolved re-export '${match[2]}' in ${path.relative(
            projectRoot,
            file,
          )}`,
        );
        continue;
      }
      if (match[1] === '*') queue.push(resolved);
      else addClause(match[1]);
    }
  }

  return found;
}

const markdown = fs.readFileSync(readmePath, 'utf8');
const blocks = tsCodeBlocks(markdown);

if (blocks.length === 0) {
  failures.push(
    `no \`\`\`ts examples found in ${readmePath}, so this check would silently pass forever`,
  );
}

// ---------------------------------------------------------------------------
// Pass 1: does every documented name resolve against the emitted output?
// ---------------------------------------------------------------------------
let checkedNames = 0;

blocks.forEach((block, index) => {
  const label = `README ts example #${index + 1}`;
  const imports = namedImports(block);

  if (imports.length === 0) {
    failures.push(
      `${label}: has no named import, so the example cannot be verified`,
    );
    return;
  }

  const importedNames = new Set();

  for (const { names, from } of imports) {
    names.forEach((name) => importedNames.add(name));
    if (!from.startsWith('.')) continue; // a package import, not this generator's output

    const target = path.resolve(projectRoot, from);
    const entry = resolveModule(target);
    if (!entry) {
      failures.push(
        `${label}: imports from '${from}', which does not exist under ${projectRoot} ` +
          `(looked for ${from}.ts and ${from}/index.ts). Run \`npm run gen-example\` first.`,
      );
      continue;
    }

    const available = reachableExports(entry);
    for (const name of names) {
      checkedNames += 1;
      if (available.has(name)) continue;
      const stem = name.replace(/Schema$/, '').replace(/One$/, '');
      const near = [...available]
        .filter((c) => stem.length > 0 && c.includes(stem))
        .sort();
      failures.push(
        `${label}: imports '${name}' from '${from}', but the generator does not emit it. ` +
          (near.length > 0
            ? `Emitted names containing '${stem}': ${near.join(', ')}`
            : 'No similarly named export exists.'),
      );
    }
  }

  // A name used but never imported breaks just as loudly as a name that is not emitted.
  for (const match of block.matchAll(/\b([A-Z][\w$]*Schema)\b/g)) {
    if (!importedNames.has(match[1])) {
      failures.push(`${label}: uses '${match[1]}' but never imports it`);
    }
  }
});

// ---------------------------------------------------------------------------
// Pass 2: does the example actually run against the emitted output?
// ---------------------------------------------------------------------------
function runExample(block, label) {
  const ts = require('typescript'); // this repo's own devDependency, not the consumer's

  // Let `require` load the emitted TypeScript. The emitted code itself is not modified.
  require.extensions['.ts'] = function (mod, filename) {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    mod._compile(out, filename);
  };

  const compiled = ts.transpileModule(block, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      esModuleInterop: true,
    },
  }).outputText;

  // Minimal stand-in for the Express app the example registers a route on.
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (routePath, handler) =>
      routes.push({ method, routePath, handler });
  }

  // Emitted schemas import `yup`, so they must resolve from the project being checked.
  const projectRequire = Module.createRequire(
    path.join(projectRoot, '__readme_check__.js'),
  );
  const moduleShim = { exports: {} };
  new Function('require', 'exports', 'module', 'app', compiled)(
    projectRequire,
    moduleShim.exports,
    moduleShim,
    app,
  );

  if (routes.length === 0) {
    notes.push(
      `${label}: imports resolved, but the example registers no route to invoke`,
    );
    return Promise.resolve();
  }

  const res = {};
  res.status = () => res;
  res.json = () => res;
  res.send = () => res;

  return routes.reduce(
    (chain, { method, routePath, handler }) =>
      chain.then(() =>
        Promise.resolve(
          handler(
            { body: { ...SAMPLE_BODY }, params: {}, query: {} },
            res,
            (err) => {
              if (err) throw err;
            },
          ),
        ).then(
          () =>
            console.log(
              `  ran ${method.toUpperCase()} ${routePath} handler, no throw`,
            ),
          (err) => {
            failures.push(
              `${label}: running the example threw ${err.name}: ${err.message}. ` +
                'If you changed the example to a different model, update SAMPLE_BODY ' +
                'in this script to match.',
            );
          },
        ),
      ),
    Promise.resolve(),
  );
}

const examplesToRun = failures.length === 0 ? blocks : [];

examplesToRun
  .reduce(
    (chain, block, index) =>
      chain.then(() => runExample(block, `README ts example #${index + 1}`)),
    Promise.resolve(),
  )
  .then(() => {
    for (const note of notes) console.warn(`note: ${note}`);

    if (failures.length > 0) {
      console.error(
        `README example check FAILED (${failures.length} problem(s)):`,
      );
      for (const failure of failures) console.error(`  - ${failure}`);
      console.error(
        '\nUse the names the generator really emits: regenerate, then grep the output ' +
          'for "export const".',
      );
      process.exit(1);
    }

    console.log(
      `README example check passed: ${checkedNames} identifier(s) across ${blocks.length} ` +
        `TypeScript example(s) resolve and run against the emitted output in ${projectRoot}`,
    );
  });
