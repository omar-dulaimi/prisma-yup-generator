#!/usr/bin/env node
/**
 * Typechecks the code the generator emits.
 *
 * This check could not exist until now. Every emitted file opened with `// @ts-nocheck`, which is
 * issue #14, and stripping it left 252 errors on the two-model example, so a check like this would
 * have been red forever and told nobody anything. Those errors are zero now, the header is gone,
 * and this is what stops it coming back.
 *
 * It typechecks the OUTPUT, not this repo's own source. `npx tsc --noEmit` already covers the
 * generator; nothing covered the thing users actually receive.
 */
const { execFileSync } = require('node:child_process');
const { readdirSync, statSync, existsSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const generated = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'prisma', 'generated');

if (!existsSync(generated)) {
  console.error(`No generated output at ${generated}. Run the generator first.`);
  process.exit(1);
}

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.ts')) files.push(full);
  }
})(generated);

if (files.length === 0) {
  console.error(`No .ts files under ${generated}.`);
  process.exit(1);
}

// A leftover header would make this check pass while hiding exactly what it exists to catch.
const suppressed = files.filter((f) =>
  require('node:fs').readFileSync(f, 'utf8').includes('@ts-nocheck')
);
if (suppressed.length > 0) {
  console.error(
    `${suppressed.length} emitted file(s) still carry @ts-nocheck, which would hide type errors:`
  );
  for (const f of suppressed.slice(0, 10)) console.error(`  ${path.relative(generated, f)}`);
  process.exit(1);
}

console.log(`Typechecking ${files.length} emitted files from ${path.relative(root, generated)} ...`);
try {
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--skipLibCheck',
      '--target', 'es2020',
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--esModuleInterop',
      ...files,
    ],
    { cwd: root, stdio: 'inherit' }
  );
} catch {
  console.error('\nThe emitted output does not typecheck. See issue #14 for why that matters.');
  process.exit(1);
}
console.log(`OK: ${files.length} emitted files typecheck with no suppression.`);
