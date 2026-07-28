#!/usr/bin/env node
'use strict';

/**
 * Checks that fields typed as a user-defined enum survive into the emitted schemas.
 *
 * They did not. `getSchemaObjectLine` only recognised input types carrying
 * `namespace: 'prisma'`, which is what Prisma's own generated types use. Anything declared
 * in the user's schema arrives as `namespace: 'model'`, and in a `.prisma` file that means
 * its `enum` blocks. Those fields were dropped from the emitted shape without a word, and
 * because yup ignores keys a shape does not mention, the result was a schema that quietly
 * validated less than it claimed: `UserCreateInputObjectSchema.validate({ email: 'a@b.c',
 * role: 'NOT_A_REAL_ROLE' })` resolved, and handed the bogus value straight back. The
 * enum's own schema file was written correctly the whole time; nothing referenced it.
 *
 * Neither of the other checks could have caught this, and the reason is worth stating: the
 * example schema this repo generates from is SQLite, and Prisma does not support `enum` on
 * SQLite. There was no fixture in which an enum field could exist, so no amount of checking
 * the example output would have found it. This check therefore carries its own schema,
 * with its own datasource, rather than reusing the example.
 *
 * Usage: node scripts/check-enum-fields.js [project-root] [generator-provider]
 *
 *   project-root       directory to generate inside, and to resolve `prisma`, `@prisma/client`
 *                      and `yup` from (default: the repo root)
 *   generator-provider the `provider` to put in the generated schema (default: this repo's
 *                      built generator). The packaged-artifact job passes the installed
 *                      package name instead, so the tarball is what gets exercised.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(process.argv[2] || repoRoot);
const provider =
  process.argv[3] || `node ${path.join(repoRoot, 'lib/generator.js')}`;

// Resolved before the resolver hook below is installed, so it always comes from this repo's
// own devDependency and never from whatever the checked project happens to have.
const ts = require('typescript');

const failures = [];
const workDir = path.join(projectRoot, '.enum-field-check');
const schemaPath = path.join(workDir, 'prisma', 'schema.prisma');

/**
 * Two enums, used two ways each: `role` is required, `status` has a default and so is
 * optional, which are the two shapes a create input can give an enum field.
 */
const SCHEMA = `generator client {
  provider = "prisma-client-js"
  output   = "../client"
}

generator yup {
  provider = "${provider}"
  output   = "./generated"
}

datasource db {
  provider = "postgresql"
  url      = "postgresql://user:password@localhost:5432/db"
}

enum Role {
  USER
  ADMIN
}

enum Status {
  DRAFT
  PUBLISHED
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  role  Role
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  status   Status @default(DRAFT)
  author   User?  @relation(fields: [authorId], references: [id])
  authorId Int?
}
`;

// The emitted schemas `import * as Yup from 'yup'`, which must resolve from the project
// being checked, not from this repo. In the packaged-artifact job those are different
// installs, and the consumer's copy is the one a user would really run.
const projectRequire = Module.createRequire(
  path.join(projectRoot, '__enum_field_check__.js'),
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

/**
 * Run the Prisma CLI the project has installed, by path rather than through `npx`, so this
 * cannot silently reach the network or pick up a different global version.
 */
function runPrismaGenerate() {
  let cliPath;
  try {
    const pkgPath = projectRequire.resolve('prisma/package.json');
    const bin = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).bin;
    cliPath = path.join(
      path.dirname(pkgPath),
      typeof bin === 'string' ? bin : bin.prisma,
    );
  } catch (err) {
    failures.push(
      `the Prisma CLI is not installed under ${projectRoot}: ${err.message}`,
    );
    return false;
  }

  // Prisma resolves a generator `provider` that is not a path by running it as a command,
  // so the provider has to be on PATH. A real consumer gets that from `npx prisma generate`,
  // which prepends the project's node_modules/.bin. Spawning the CLI through `process.execPath`
  // does not. The packaged-artifact job is the only caller that passes a bare package name,
  // and it failed every single run with `/bin/sh: 1: prisma-yup-generator: not found`, which
  // the early return below then swallowed. Resolve the provider the way the consumer does.
  const binDir = path.join(projectRoot, 'node_modules', '.bin');
  const result = spawnSync(
    process.execPath,
    [cliPath, 'generate', '--schema', schemaPath],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      },
    },
  );

  if (result.status !== 0) {
    failures.push(
      `prisma generate exited ${result.status} for the enum schema:\n` +
        `${(result.stderr || result.stdout || '').trim()}`,
    );
    return false;
  }
  return true;
}

const isSchema = (value) =>
  Boolean(value) && typeof value.validate === 'function';

/** Resolving is a pass, a ValidationError is a rejection, anything else is a crash. */
async function outcome(schema, value) {
  try {
    await schema.validate(value);
    return 'accepted';
  } catch (err) {
    if (err && err.name === 'ValidationError') return 'rejected';
    return `crashed (${err && err.name}: ${err && err.message})`;
  }
}

async function expect(label, schema, value, wanted, why) {
  const got = await outcome(schema, value);
  if (got === wanted) return;
  failures.push(`${label}: expected ${wanted}, got ${got}. ${why}`);
}

/**
 * The checks themselves, deliberately in their own function rather than inline in the runner
 * below.
 *
 * They return early on the paths where there is nothing further to check, and those returns
 * used to sit inside the runner's `try`. A `return` there ran `finally`, skipped the block
 * that prints `failures` and calls `process.exit(1)`, resolved the promise with nothing
 * pending, and Node exited 0. So the gate reported success while discarding every message
 * pushed into `failures` on the way out. Returning from this function only ends the checks;
 * the caller still reports them.
 */
async function runChecks() {
  if (!runPrismaGenerate()) return;

  const objectsIndex = path.join(
    workDir,
    'prisma',
    'generated',
    'schemas',
    'objects',
    'index.ts',
  );
  if (!fs.existsSync(objectsIndex)) {
    failures.push(
      `the generator produced no object schemas for the enum schema (expected ${objectsIndex})`,
    );
    return;
  }

  const objects = require(objectsIndex);

  // --- 1. the enum fields exist at all -----------------------------------
  const expectedFields = [
    ['UserCreateInputObjectSchema', 'role'],
    ['PostCreateInputObjectSchema', 'status'],
    ['UserUncheckedCreateInputObjectSchema', 'role'],
  ];
  for (const [schemaName, fieldName] of expectedFields) {
    const schema = objects[schemaName];
    if (!isSchema(schema)) {
      failures.push(`${schemaName} is not exported from the emitted output`);
      continue;
    }
    const keys = Object.keys(schema.fields || {});
    if (keys.includes(fieldName)) continue;
    failures.push(
      `${schemaName} has no '${fieldName}' key, so a field typed as a user-defined enum ` +
        `was dropped from the emitted shape. yup ignores keys a shape does not mention, ` +
        `so that value goes unvalidated. Emitted keys: ${
          keys.join(', ') || '(none)'
        }`,
    );
  }

  // --- 2. the enum is actually enforced ----------------------------------
  const userCreate = objects.UserCreateInputObjectSchema;
  if (isSchema(userCreate)) {
    await expect(
      "UserCreateInput with role 'ADMIN'",
      userCreate,
      { email: 'a@b.c', role: 'ADMIN' },
      'accepted',
      'ADMIN is a declared value of the Role enum.',
    );
    await expect(
      "UserCreateInput with role 'NOT_A_REAL_ROLE'",
      userCreate,
      { email: 'a@b.c', role: 'NOT_A_REAL_ROLE' },
      'rejected',
      'This is the silent under-validation: an undeclared enum value must not pass.',
    );
  }

  // --- 3. list positions hold a list -------------------------------------
  // `where: { role: { in: ['USER'] } }` is ordinary Prisma. Enums used to be exempted
  // from the array wrapper, so the bare enum saw an array and rejected it.
  const roleFilter = objects.EnumRoleFilterObjectSchema;
  if (isSchema(roleFilter)) {
    await expect(
      "EnumRoleFilter with in: ['USER']",
      roleFilter,
      { in: ['USER'] },
      'accepted',
      'A list of enum values is what Prisma sends for `in`.',
    );
    await expect(
      "EnumRoleFilter with in: ['NOPE']",
      roleFilter,
      { in: ['NOPE'] },
      'rejected',
      'The array wrapper must still check what is inside it.',
    );
  } else {
    failures.push(
      'EnumRoleFilterObjectSchema is not exported from the emitted output',
    );
  }
}

(async () => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(workDir, 'prisma'), { recursive: true });
  fs.writeFileSync(schemaPath, SCHEMA);

  try {
    await runChecks();
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(path.join(projectRoot, 'client'), {
      recursive: true,
      force: true,
    });
  }

  if (failures.length > 0) {
    console.error(`enum field check FAILED (${failures.length} problem(s)):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      '\nA field the emitted schema omits is a field nobody validates. See ' +
        'scripts/check-enum-fields.js for why the example schema cannot cover this.',
    );
    process.exit(1);
  }

  console.log(
    `enum field check passed: user-defined enum fields are emitted and enforced by the ` +
      `output generated in ${projectRoot}`,
  );
})().catch((err) => {
  console.error('enum field check could not run:');
  console.error(err);
  process.exit(1);
});
