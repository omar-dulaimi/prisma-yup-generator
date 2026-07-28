#!/usr/bin/env node
'use strict';

/**
 * Checks that the emitted schemas actually validate, rather than throwing from yup's
 * internals.
 *
 * The generated modules all import each other through `internals.ts`, and every reference
 * used to be read at module-evaluation time. `internals.ts` re-exports them in one fixed
 * order, so any module that ran before the module it referenced saw `undefined` and put
 * that `undefined` straight into its yup shape. Nothing complained at import time. It only
 * surfaced later, inside yup: `getDefaultFromShape` does `'default' in field`, which throws
 * `TypeError: Cannot use 'in' operator to search for 'default' in undefined` the first time
 * a key is missing from the validated value. So `PostCreateSchema.validate({})` crashed
 * while `PostCreateSchema.validate({ data: {...} })` passed, and the README example only
 * ever exercised the second one.
 *
 * Ordering `internals.ts` better cannot fix this: the reference graph contains a genuine
 * cycle (PostListRelationFilter -> PostWhereInput -> UserRelationFilter -> UserWhereInput ->
 * PostListRelationFilter), so no evaluation order exists in which every reference is already
 * defined. The generator therefore defers every cross-schema reference with
 * `Yup.lazy(() => X.default(undefined))`, which is the same construct it already used for
 * self-references.
 *
 * This check runs the emitted schemas. It deliberately does not typecheck them: that output
 * needs its `// @ts-nocheck` header to compile at all (see issue #14), so typechecking here
 * would be red forever and would say nothing about whether the schemas work.
 *
 * A throw is only a failure when it is not a `ValidationError`. Rejecting bad input is the
 * job; crashing is the bug.
 *
 * Usage: node scripts/check-emitted-schemas-validate.js [project-root]
 *
 *   project-root  directory holding `prisma/generated` (default: the repo root, which is
 *                 where `npm run gen-example` puts it)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const repoRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(process.argv[2] || repoRoot);
const schemasDir = path.join(projectRoot, 'prisma/generated/schemas');

// Resolved before the resolver hook below is installed, so it always comes from this repo's
// own devDependency and never from whatever the checked project happens to have.
const ts = require('typescript');

const failures = [];

const TRANSPILE_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2019,
  esModuleInterop: true,
};

// --- load the emitted TypeScript without modifying it ----------------------
require.extensions['.ts'] = function (mod, filename) {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: TRANSPILE_OPTIONS,
    fileName: filename,
  }).outputText;
  mod._compile(out, filename);
};

// The emitted schemas `import * as Yup from 'yup'`, which must resolve from the project
// being checked, not from this repo. In the packaged-artifact job those are different
// installs, and the consumer's copy is the one a user would really run.
const projectRequire = Module.createRequire(
  path.join(projectRoot, '__schema_check__.js'),
);
const defaultResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (!request.startsWith('.') && !path.isAbsolute(request)) {
    try {
      return projectRequire.resolve(request);
    } catch (err) {
      // not installed in the project: fall through to normal resolution
    }
  }
  return defaultResolve.call(this, request, ...rest);
};

function loadModule(relative) {
  const file = path.join(schemasDir, relative);
  if (!fs.existsSync(file)) {
    failures.push(
      `${relative} does not exist under ${schemasDir}. Run \`npm run gen-example\` first.`,
    );
    return {};
  }
  return require(file);
}

/**
 * Run one validation. Resolving is fine, rejecting with a ValidationError is fine, anything
 * else is the defect this check exists for.
 */
async function expectNoCrash(label, schema, value) {
  try {
    await schema.validate(value);
    return 'resolved';
  } catch (err) {
    if (err && err.name === 'ValidationError') return 'rejected';
    failures.push(
      `${label} threw ${err && err.name}: ${err && err.message}. ` +
        'A schema must reject bad input with a ValidationError, not crash.',
    );
    return 'crashed';
  }
}

const isSchema = (value) =>
  Boolean(value) && typeof value.validate === 'function';

(async () => {
  const entry = loadModule('index.ts');
  const objects = loadModule('objects/index.ts');

  let checks = 0;
  const tally = { resolved: 0, rejected: 0, crashed: 0 };
  const record = async (label, schema, value) => {
    checks += 1;
    tally[await expectNoCrash(label, schema, value)] += 1;
  };

  // -------------------------------------------------------------------------
  // 1. The three cases reported on issue #14, by name. Each one is an ordinary
  //    thing to do with these schemas and each one threw a TypeError.
  // -------------------------------------------------------------------------
  const reported = [
    ['PostCreateSchema.validate({})', 'PostCreateSchema', {}],
    [
      "UserCreateSchema.validate({ email: 'a@b.c' })",
      'UserCreateSchema',
      { email: 'a@b.c' },
    ],
    [
      "PostFindManySchema.validate({ where: { title: { equals: 'x' } } })",
      'PostFindManySchema',
      { where: { title: { equals: 'x' } } },
    ],
  ];

  for (const [label, exportName, value] of reported) {
    const schema = entry[exportName];
    if (!isSchema(schema)) {
      failures.push(
        `${exportName} is not exported from the emitted index, so issue #14's ` +
          'reported cases cannot be checked. If the example schema changed, update this list.',
      );
      continue;
    }
    await record(label, schema, value);
  }

  // -------------------------------------------------------------------------
  // 2. Every documented schema, validated with an empty object. This is the
  //    general form of the bug: every key is absent, so every field's default
  //    is computed.
  // -------------------------------------------------------------------------
  for (const [name, schema] of Object.entries(entry)) {
    if (!isSchema(schema)) continue;
    await record(`${name}.validate({})`, schema, {});
  }

  // -------------------------------------------------------------------------
  // 3. Every object schema, twice: empty, and with each of its own keys present
  //    as a plain object. The second pass reaches the nested references and the
  //    `oneOfSchemas` helper, which throws its own TypeError when handed an
  //    alternative that resolved to undefined (issue #12).
  // -------------------------------------------------------------------------
  for (const [name, schema] of Object.entries(objects)) {
    if (!isSchema(schema)) continue;
    await record(`${name}.validate({})`, schema, {});

    const keys = Object.keys(schema.fields || {});
    if (keys.length === 0) continue;
    const populated = {};
    for (const key of keys) populated[key] = {};
    await record(
      `${name}.validate({ ${keys.length} key(s) present })`,
      schema,
      populated,
    );
  }

  // -------------------------------------------------------------------------
  // 3b. No schema may have a key named after a schema.
  //
  //     `deleteMany` was emitted as `Yup.object({ PostWhereInputObjectSchema })`
  //     instead of `Yup.object({ where: PostWhereInputObjectSchema })`. Object
  //     shorthand made that a valid program with a key called
  //     "PostWhereInputObjectSchema", so nothing anywhere complained.
  //
  //     Passes 1-3 could not see it. A wrongly named key is not a crash: yup
  //     ignores keys a shape does not mention, so `where` went unvalidated,
  //     `PostDeleteManySchema.validate({})` resolved to
  //     `{ PostWhereInputObjectSchema: {} }`, and feeding that to
  //     `prisma.post.deleteMany` fails on an argument Prisma has never heard of.
  //
  //     A field named like a schema identifier is always this slip, so the whole
  //     class is cheap to trap by name.
  // -------------------------------------------------------------------------
  const looksLikeSchemaIdentifier = /(?:Object)?Schema$/;
  for (const [source, exports] of [
    ['emitted index', entry],
    ['emitted objects', objects],
  ]) {
    for (const [name, schema] of Object.entries(exports)) {
      if (!isSchema(schema)) continue;
      for (const key of Object.keys(schema.fields || {})) {
        if (!looksLikeSchemaIdentifier.test(key)) continue;
        failures.push(
          `${source}: ${name} has a field called '${key}', which is a schema name rather ` +
            'than an argument name. This is object shorthand written where `argument: Schema` ' +
            'was meant, so the real argument is not validated at all and a key Prisma does ' +
            'not accept is added to the validated value.',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. The same schemas, compiled to JavaScript and required as JavaScript.
  //
  //    Passes 1-3 load the emitted `.ts` files through the hook installed at the
  //    top of this script, so they only ever exercise the TypeScript sources.
  //    Almost nobody runs those directly. A TypeScript user compiles them first,
  //    and that is a different artifact.
  //
  //    The gap hid a real break. Every emitted object schema imported the helper
  //    as `'../helpers/oneOfSchemas.helper.ts'`, extension and all, which `tsc`
  //    turned into `require('../helpers/oneOfSchemas.helper.ts')`. Nothing by
  //    that name sits next to the compiled output, so the first `require` of a
  //    built schema threw `Cannot find module`, while this check stayed green.
  // -------------------------------------------------------------------------
  const compiledDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yup-schemas-compiled-'),
  );
  try {
    // A parent directory with `"type": "module"` would make Node read the
    // compiled CommonJS as ESM and fail for reasons that have nothing to do with
    // the generator, so say what these files are rather than inheriting it.
    fs.writeFileSync(
      path.join(compiledDir, 'package.json'),
      JSON.stringify({ name: 'compiled-schemas', type: 'commonjs' }),
    );

    let compiledCount = 0;
    const compileTree = (fromDir, toDir) => {
      fs.mkdirSync(toDir, { recursive: true });
      for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
        const from = path.join(fromDir, entry.name);
        if (entry.isDirectory()) {
          compileTree(from, path.join(toDir, entry.name));
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const js = ts.transpileModule(fs.readFileSync(from, 'utf8'), {
          compilerOptions: TRANSPILE_OPTIONS,
          fileName: from,
        }).outputText;
        fs.writeFileSync(
          path.join(toDir, entry.name.replace(/\.ts$/, '.js')),
          js,
        );
        compiledCount += 1;
      }
    };
    compileTree(schemasDir, compiledDir);

    if (compiledCount === 0) {
      failures.push(
        `no .ts files were found under ${schemasDir} to compile, so the compiled-output ` +
          'check would silently pass forever',
      );
    }

    // `require` of the compiled entry point pulls in the whole graph, so a
    // specifier that does not survive compilation throws right here.
    let compiledEntry = {};
    let compiledObjects = {};
    try {
      compiledEntry = require(path.join(compiledDir, 'index.js'));
      compiledObjects = require(path.join(compiledDir, 'objects', 'index.js'));
    } catch (err) {
      failures.push(
        `the emitted schemas compile but the compiled JavaScript cannot be loaded: ` +
          `${err && err.name}: ${err && err.message}. Every TypeScript user builds this ` +
          'output before running it, so a specifier that only resolves for the .ts ' +
          'sources is broken for all of them.',
      );
    }

    for (const [name, schema] of Object.entries(compiledEntry)) {
      if (!isSchema(schema)) continue;
      await record(`compiled ${name}.validate({})`, schema, {});
    }
    for (const [name, schema] of Object.entries(compiledObjects)) {
      if (!isSchema(schema)) continue;
      const keys = Object.keys(schema.fields || {});
      const populated = {};
      for (const key of keys) populated[key] = {};
      await record(`compiled ${name}.validate({...})`, schema, populated);
    }
  } finally {
    fs.rmSync(compiledDir, { recursive: true, force: true });
  }

  if (checks === 0) {
    failures.push(
      'no schemas were checked, so this check would silently pass forever',
    );
  }

  if (failures.length > 0) {
    console.error(
      `emitted schema check FAILED (${failures.length} problem(s) across ${checks} validations):`,
    );
    const shown = failures.slice(0, 25);
    for (const failure of shown) console.error(`  - ${failure}`);
    if (failures.length > shown.length) {
      console.error(`  ... and ${failures.length - shown.length} more`);
    }
    console.error(
      '\nA schema that throws from yup instead of returning a ValidationError is unusable ' +
        'at runtime. See scripts/check-emitted-schemas-validate.js for the cause.',
    );
    process.exit(1);
  }

  console.log(
    `emitted schema check passed: ${checks} validations against the output in ${projectRoot} ` +
      `(${tally.resolved} resolved, ${tally.rejected} rejected with a ValidationError, ` +
      `0 crashed)`,
  );
})().catch((err) => {
  console.error('emitted schema check could not run:');
  console.error(err);
  process.exit(1);
});
