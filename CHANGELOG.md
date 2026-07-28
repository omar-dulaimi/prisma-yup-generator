## [1.0.0](https://github.com/omar-dulaimi/prisma-yup-generator/compare/v0.2.0...v1.0.0) (2026-07-28)

### ⚠ BREAKING CHANGES

* **breaking:** emitted files no longer begin with `// @ts-nocheck`. Anyone who
was relying on that header to mask errors in code they hand-edited alongside the
output will now see them. That is the point.

Also adds scripts/check-emitted-output-typechecks.js and runs it in both CI jobs,
against the working tree and against the tarball installed into an empty consumer.
This check could not exist before: it would have been red forever. It fails on a
type error and also on a stray @ts-nocheck, since a reappearing header would make
it pass while hiding the thing it exists to catch. Both cases were mutation
tested. Gate green on Node 22 and 24: 119 emitted files typecheck with no
suppression, and the validate, README and enum checks all still pass.

### 🐛 Bug Fixes

* **breaking:** stop emitting [@ts-nocheck](https://github.com/ts-nocheck), the output now typechecks ([4a6eee8](https://github.com/omar-dulaimi/prisma-yup-generator/commit/4a6eee8302782e65f9cc209bac4f50a70d22d6eb)), closes [#14](https://github.com/omar-dulaimi/prisma-yup-generator/issues/14)
* **ci:** make the release path able to fail ([b2ff9dd](https://github.com/omar-dulaimi/prisma-yup-generator/commit/b2ff9dda5f1a91bcbb9a0a40037f3d2ae5026300))
* defer generated schema references so validation cannot crash ([bf61842](https://github.com/omar-dulaimi/prisma-yup-generator/commit/bf618429df917926941f3eddb740aa7b1fdb005c)), closes [#14](https://github.com/omar-dulaimi/prisma-yup-generator/issues/14) [#12](https://github.com/omar-dulaimi/prisma-yup-generator/issues/12)
* give deleteMany a where argument instead of a key named after a schema ([fcc59d1](https://github.com/omar-dulaimi/prisma-yup-generator/commit/fcc59d176be3605f16a84e78f3bbb7cefce847dc))
* **release:** add CI gate and tokenless OIDC release pipeline ([6e63220](https://github.com/omar-dulaimi/prisma-yup-generator/commit/6e632206216a95907289b8f8c0871892943f28cd))
* stop dropping fields typed as a user-defined enum ([c3a7e87](https://github.com/omar-dulaimi/prisma-yup-generator/commit/c3a7e87960f214980833adbd46c673b588b65260))
* stop internals.ts re-exporting one module twice ([0b5d16c](https://github.com/omar-dulaimi/prisma-yup-generator/commit/0b5d16c2bd3fd4d94e0f3d76f49cd125a51c3185))
* type the oneOfSchemas helper so the emitted schemas can compile ([c969445](https://github.com/omar-dulaimi/prisma-yup-generator/commit/c9694456323331c85f78895cfdee693eb06ad4be))
* upsert takes create, not data ([5b575be](https://github.com/omar-dulaimi/prisma-yup-generator/commit/5b575be07d7b2d9b705a5e21224ead00d59ca96d))

### 📚 Documentation

* **ci:** correct the emitted-output error count and say what is left ([912e811](https://github.com/omar-dulaimi/prisma-yup-generator/commit/912e811f1b8b8c7b177a27416db7e7eb8cf641cf))
* fix the README example to match the schemas actually emitted ([00c3a03](https://github.com/omar-dulaimi/prisma-yup-generator/commit/00c3a03966e941b232bd7f4d81ea475f610c6cf6)), closes [#14](https://github.com/omar-dulaimi/prisma-yup-generator/issues/14)
