import type { DMMF as PrismaDMMF } from '@prisma/generator-helper';
import path from 'path';
import { writeFileSafely } from './utils/writeFileSafely';

export default class Transformer {
  name?: string;
  fields?: PrismaDMMF.SchemaArg[];
  schemaImports?: Set<string>;
  /**
   * Whether this schema ended up using the `oneOfSchemas` helper, so that only the files
   * that call it import it. Set while the fields are turned into yup lines, which happens
   * before the imports are rendered.
   */
  usesOneOfSchemas = false;
  modelOperations?: PrismaDMMF.ModelMapping[];
  enumTypes?: PrismaDMMF.SchemaEnum[];
  static enumNames: Array<string> = [];
  static generatedSchemaFiles: Array<string> = [];
  static generatedSchemaObjectFiles: Array<string> = [];
  static generatedSchemaEnumFiles: Array<string> = [];
  static internals: Array<string> = [];
  private static outputPath?: string;
  constructor({
    name,
    fields,
    modelOperations,
    enumTypes,
  }: {
    name?: string | undefined;
    fields?: PrismaDMMF.SchemaArg[] | undefined;
    schemaImports?: Set<string>;
    modelOperations?: PrismaDMMF.ModelMapping[];
    enumTypes?: PrismaDMMF.SchemaEnum[];
  }) {
    this.name = name ?? '';
    this.fields = fields ?? [];
    this.modelOperations = modelOperations ?? [];
    this.schemaImports = new Set();
    this.enumTypes = enumTypes;
  }

  static setOutputPath(outPath: string) {
    this.outputPath = outPath;
  }

  static getOutputPath() {
    return this.outputPath;
  }

  addSchemaImport(name: string) {
    this.schemaImports?.add(name);
  }

  getAllSchemaImports() {
    return [...(this.schemaImports ?? [])]
      .map((name) =>
        Transformer.enumNames.includes(name)
          ? `import { ${name}Schema } from '../internals';`
          : [`import { ${name}ObjectSchema } from '../internals';`],
      )
      .flatMap((item) => item)
      .join(';\r\n');
  }

  /**
   * A reference to another generated schema, deferred until validation time.
   *
   * Every generated module imports its references from `internals.ts`, and `internals.ts`
   * re-exports them in one fixed order, so a module that evaluates before the module it
   * references reads `undefined`. Reading the reference eagerly put that `undefined` into
   * the yup shape, and yup then threw `TypeError: Cannot use 'in' operator to search for
   * 'default' in undefined` the first time a key was absent from the validated value.
   *
   * Ordering `internals.ts` differently cannot fix that. Prisma's input types are
   * genuinely cyclic (PostListRelationFilter -> PostWhereInput -> UserRelationFilter ->
   * UserWhereInput -> PostListRelationFilter), so no order exists in which every reference
   * is already defined, and wiring a cycle up eagerly makes yup's `getDefaultFromShape`
   * recurse until the stack overflows.
   *
   * `Yup.lazy` reads the reference when the schema is used instead, by which point every
   * module has finished evaluating. `.default(undefined)` is what stops the recursion: yup
   * computes an object schema's default from its shape unless a default is set, so without
   * it a cycle still overflows the stack.
   */
  static deferredSchemaReference(type: string) {
    const schemaName = Transformer.enumNames.includes(type)
      ? `${type}Schema`
      : `${type}ObjectSchema`;
    return `Yup.lazy(() => ${schemaName}.default(undefined))`;
  }

  /**
   * Whether this input type refers to another schema this generator emits, rather than to
   * a plain scalar.
   *
   * Both namespaces matter. Prisma's own generated types carry `namespace: 'prisma'`, which
   * covers input objects like `PostWhereInput` and enums like `SortOrder`. Anything declared
   * in the user's own schema carries `namespace: 'model'`, and for a `.prisma` file that is
   * exactly its `enum` blocks.
   *
   * Only `'prisma'` used to be accepted, so every field typed as a user-defined enum was
   * dropped from the emitted shape without a word. The enum's own schema file was written
   * correctly the whole time; nothing ever referenced it. Because yup ignores keys a shape
   * does not mention, that made the schemas silently permissive: a `role` of
   * `'NOT_A_REAL_ROLE'` validated clean and came back out of `validate()` untouched.
   */
  static isGeneratedSchemaReference(
    inputType: PrismaDMMF.SchemaArgInputType,
  ): boolean {
    return inputType.namespace === 'prisma' || inputType.namespace === 'model';
  }

  getPrismaStringLine(
    field: PrismaDMMF.SchemaArg,
    inputType: PrismaDMMF.SchemaArgInputType,
    inputsLength: number,
  ) {
    if (inputsLength < 1) return '';

    const type = inputType.type as string;
    const reference = Transformer.deferredSchemaReference(type);

    // A list is a list whatever it holds. Enums used to be exempted here, which meant
    // `role: { in: ['USER'] }` was checked against the bare enum and rejected for not being
    // one of its values. That exemption never showed because the only fields it could reach
    // were dropped before they got this far.
    const yupType = inputType.isList
      ? `Yup.array().of(${reference})`
      : reference;

    return inputsLength === 1 ? `  ${field.name}: ${yupType}` : yupType;
  }

  getSchemaObjectLine(field: PrismaDMMF.SchemaArg) {
    let lines: any = field.inputTypes;

    const inputsLength = field.inputTypes.length;
    if (inputsLength === 0) return lines;

    if (inputsLength === 1) {
      lines = lines.map((inputType: PrismaDMMF.SchemaArgInputType) => {
        if (inputType.type === 'String') {
          return [
            `  ${field.name}: ${
              inputType.isList ? 'Yup.array().of(Yup.string())' : 'Yup.string()'
            }`,
            field,
          ];
        } else if (inputType.type === 'Int' || inputType.type === 'Float') {
          return [
            `  ${field.name}: ${
              inputType.isList ? 'Yup.array().of(Yup.number())' : 'Yup.number()'
            }`,
            field,
          ];
        } else if (inputType.type === 'Boolean') {
          return [
            `  ${field.name}: ${
              inputType.isList
                ? 'Yup.array().of(Yup.boolean())'
                : 'Yup.boolean()'
            }`,
            field,
          ];
        } else if (inputType.type === 'DateTime') {
          return [
            `  ${field.name}: ${
              inputType.isList ? 'Yup.array().of(Yup.date())' : 'Yup.date()'
            }`,
            field,
          ];
        } else {
          if (Transformer.isGeneratedSchemaReference(inputType)) {
            if (inputType.type !== this.name) {
              this.addSchemaImport(inputType.type as string);
            }

            return [
              this.getPrismaStringLine(field, inputType, inputsLength),
              field,
              true,
            ];
          }
        }
        return [];
      });
    } else {
      const alternatives = lines.reduce(
        (result: Array<string>, inputType: PrismaDMMF.SchemaArgInputType) => {
          if (inputType.type === 'String') {
            result.push(
              inputType.isList
                ? 'Yup.array().of(Yup.string())'
                : 'Yup.string()',
            );
          } else if (inputType.type === 'Int' || inputType.type === 'Float') {
            result.push(
              inputType.isList
                ? 'Yup.array().of(Yup.number())'
                : 'Yup.number()',
            );
          } else if (inputType.type === 'Boolean') {
            result.push(
              inputType.isList
                ? 'Yup.array().of(Yup.boolean())'
                : 'Yup.boolean()',
            );
          } else {
            if (Transformer.isGeneratedSchemaReference(inputType)) {
              if (inputType.type !== this.name) {
                this.addSchemaImport(inputType.type as string);
              }
              result.push(
                this.getPrismaStringLine(field, inputType, inputsLength),
              );
            } else if (inputType.type === 'Json') {
              result.push(
                inputType.isList
                  ? 'Yup.array().of(Yup.mixed())'
                  : 'Yup.mixed()',
              );
            }
          }
          return result;
        },
        [],
      );

      if (alternatives.length > 0) {
        this.usesOneOfSchemas = true;
        lines = [
          [
            `  ${field.name}: oneOfSchemas([${alternatives.join(',\r\n')}])`,
            field,
            true,
          ],
        ];
      } else {
        return [[]];
      }
    }

    return lines.filter(Boolean);
  }

  getFieldValidators(
    yupStringWithMainType: string,
    field: PrismaDMMF.SchemaArg,
  ) {
    let yupStringWithAllValidators = yupStringWithMainType;
    const { isRequired, isNullable } = field;
    if (isRequired) {
      yupStringWithAllValidators += '.required()';
    }
    if (isNullable) {
      yupStringWithAllValidators += '.allow(null)';
    }
    return yupStringWithAllValidators;
  }

  wrapWithObject({
    yupStringFields,
    isArray = true,
    forData = false,
  }: {
    yupStringFields: string;
    isArray?: boolean;
    forData?: boolean;
  }) {
    let wrapped = '{';
    wrapped += '\n';
    wrapped += isArray
      ? '  ' + (yupStringFields as unknown as Array<string>).join(',\r\n')
      : '  ' + yupStringFields;
    wrapped += '\n';
    wrapped += forData ? '  ' + '}' : '}';
    return wrapped;
  }

  wrapWithYupObject({ yupStringFields }: { yupStringFields: string }) {
    let wrapped = 'Yup.object({';
    wrapped += '\n';
    wrapped += '  ' + yupStringFields;
    wrapped += '\n';
    wrapped += '})';
    return wrapped;
  }

  getImportYup() {
    let yupImportStatement = "import * as Yup from 'yup';";
    yupImportStatement += '\n';
    return yupImportStatement;
  }

  getImportsForObjectSchemas() {
    let imports = this.getImportYup();
    imports += this.getHelpersImports();
    imports += this.getAllSchemaImports();
    imports += '\n\n';
    return imports;
  }

  getImportsForSchemas(additionalImports: Array<string>) {
    let imports = this.getImportYup();
    imports += [...additionalImports].join(';\r\n');
    imports += '\n\n';
    return imports;
  }

  addExportSchemaObject(schema: string) {
    return `export const ${this.name}SchemaObject = ${schema};`;
  }

  addExportObjectSchema(schema: string) {
    return `export const ${this.name}ObjectSchema = ${schema};`;
  }

  addExportSchema(schema: string, name: string) {
    return `export const ${name}Schema = ${schema}`;
  }

  getImportNoCheck() {
    let imports = '// @ts-nocheck';
    imports += '\n';
    return imports;
  }

  /**
   * Imports the `oneOfSchemas` helper, and only into the files that call it.
   *
   * The specifier deliberately carries no `.ts` extension. It used to, and it was a
   * side-effect-only import, so `tsc` turned it into `require('../helpers/oneOfSchemas.helper.ts')`
   * in the compiled JavaScript. No such file exists next to the compiled output, so anyone
   * who built the emitted schemas got `Cannot find module` at run time. Only the checks that
   * load the TypeScript sources directly ever passed.
   */
  getHelpersImports() {
    if (!this.usesOneOfSchemas) return '';
    let imports =
      "import { oneOfSchemas } from '../helpers/oneOfSchemas.helper';";
    imports += '\n';
    return imports;
  }

  getFinalForm(yupStringFields: string) {
    const objectSchema = `${this.addExportObjectSchema(
      this.wrapWithYupObject({ yupStringFields }),
    )}\n`;
    return `${this.getImportNoCheck()}${this.getImportsForObjectSchemas()}${objectSchema}`;
  }
  async printSchemaObjects() {
    const yupStringFields = (this.fields ?? [])
      .map((field) => {
        const value = this.getSchemaObjectLine(field);
        return value;
      })
      .flatMap((item) => item)
      .filter((item) => item && item.length > 0)
      .map((item) => {
        const [yupStringWithMainType, field, skipValidators] = item;
        const value = skipValidators
          ? yupStringWithMainType
          : this.getFieldValidators(yupStringWithMainType, field);
        return value;
      });

    await writeFileSafely(
      path.join(
        Transformer.outputPath,
        `schemas/objects/${this.name}.schema.ts`,
      ),
      this.getFinalForm(yupStringFields as unknown as string),
    );
    Transformer.generatedSchemaObjectFiles.push(`./${this.name}.schema`);
    Transformer.internals.push(`./objects/${this.name}.schema`);
  }

  async printModelSchemas() {
    for (const model of this.modelOperations ?? []) {
      const {
        model: modelName,
        findUnique,
        findFirst,
        findMany,
        // @ts-ignore
        createOne,
        // @ts-ignore
        deleteOne,
        // @ts-ignore
        updateOne,
        deleteMany,
        updateMany,
        // @ts-ignore
        upsertOne,
        aggregate,
        groupBy,
      } = model;

      if (findUnique) {
        const imports = [
          `import { ${modelName}WhereUniqueInputObjectSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(Transformer.outputPath, `schemas/${findUnique}.schema.ts`),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ where: ${modelName}WhereUniqueInputObjectSchema }).required()`,
            `${modelName}FindUnique`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${findUnique}.schema`);
      }

      if (findFirst) {
        const imports = [
          `import { ${modelName}WhereInputObjectSchema, ${modelName}OrderByWithRelationInputObjectSchema, ${modelName}WhereUniqueInputObjectSchema } from './internals'`,
          `import { ${modelName}ScalarFieldEnumSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(Transformer.outputPath, `schemas/${findFirst}.schema.ts`),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ where: ${modelName}WhereInputObjectSchema, orderBy: ${modelName}OrderByWithRelationInputObjectSchema, cursor: ${modelName}WhereUniqueInputObjectSchema, take: Yup.number(), skip: Yup.number(), distinct: Yup.array().of(${modelName}ScalarFieldEnumSchema) }).required()`,
            `${modelName}FindFirst`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${findFirst}.schema`);
      }

      if (findMany) {
        const imports = [
          `import { ${modelName}WhereInputObjectSchema, ${modelName}OrderByWithRelationInputObjectSchema, ${modelName}WhereUniqueInputObjectSchema } from './internals'`,
          `import { ${modelName}ScalarFieldEnumSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(Transformer.outputPath, `schemas/${findMany}.schema.ts`),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ where: ${modelName}WhereInputObjectSchema, orderBy: ${modelName}OrderByWithRelationInputObjectSchema, cursor: ${modelName}WhereUniqueInputObjectSchema, take: Yup.number(), skip: Yup.number(), distinct: Yup.array().of(${modelName}ScalarFieldEnumSchema)  }).required()`,
            `${modelName}FindMany`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${findMany}.schema`);
      }

      if (createOne) {
        const imports = [
          `import { ${modelName}CreateInputObjectSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(Transformer.outputPath, `schemas/${createOne}.schema.ts`),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ data: ${modelName}CreateInputObjectSchema  }).required()`,
            `${modelName}Create`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${createOne}.schema`);
      }

      if (deleteOne) {
        const imports = [
          `import { ${modelName}WhereUniqueInputObjectSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(
            Transformer.outputPath,
            `schemas/${deleteOne}.schema.ts`,
          ),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ where: ${modelName}WhereUniqueInputObjectSchema  }).required()`,
            `${modelName}DeleteOne`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${deleteOne}.schema`);
      }

      if (deleteMany) {
        const imports = [
          `import { ${modelName}WhereInputObjectSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(Transformer.outputPath, `schemas/${deleteMany}.schema.ts`),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ ${modelName}WhereInputObjectSchema  }).required()`,
            `${modelName}DeleteMany`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${deleteMany}.schema`);
      }

      if (updateOne) {
        const imports = [
          `import { ${modelName}UpdateInputObjectSchema, ${modelName}WhereUniqueInputObjectSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(Transformer.outputPath, `schemas/${updateOne}.schema.ts`),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ data: ${modelName}UpdateInputObjectSchema, where: ${modelName}WhereUniqueInputObjectSchema  }).required()`,
            `${modelName}UpdateOne`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${updateOne}.schema`);
      }

      if (updateMany) {
        const imports = [
          `import { ${modelName}UpdateManyMutationInputObjectSchema, ${modelName}WhereInputObjectSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(Transformer.outputPath, `schemas/${updateMany}.schema.ts`),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ data: ${modelName}UpdateManyMutationInputObjectSchema, where: ${modelName}WhereInputObjectSchema  }).required()`,
            `${modelName}UpdateMany`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${updateMany}.schema`);
      }

      if (upsertOne) {
        const imports = [
          `import { ${modelName}WhereUniqueInputObjectSchema, ${modelName}CreateInputObjectSchema, ${modelName}UpdateInputObjectSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(Transformer.outputPath, `schemas/${upsertOne}.schema.ts`),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ where: ${modelName}WhereUniqueInputObjectSchema, data: ${modelName}CreateInputObjectSchema, update: ${modelName}UpdateInputObjectSchema  }).required()`,
            `${modelName}Upsert`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${upsertOne}.schema`);
      }

      if (aggregate) {
        const imports = [
          `import { ${modelName}WhereInputObjectSchema, ${modelName}OrderByWithRelationInputObjectSchema, ${modelName}WhereUniqueInputObjectSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(Transformer.outputPath, `schemas/${aggregate}.schema.ts`),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ where: ${modelName}WhereInputObjectSchema, orderBy: ${modelName}OrderByWithRelationInputObjectSchema, cursor: ${modelName}WhereUniqueInputObjectSchema, take: Yup.number(), skip: Yup.number()  }).required()`,
            `${modelName}Aggregate`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${aggregate}.schema`);
      }

      if (groupBy) {
        const imports = [
          `import { ${modelName}WhereInputObjectSchema, ${modelName}OrderByWithAggregationInputObjectSchema, ${modelName}ScalarWhereWithAggregatesInputObjectSchema } from './internals'`,
          `import { ${modelName}ScalarFieldEnumSchema } from './internals'`,
        ];
        await writeFileSafely(
          path.join(Transformer.outputPath, `schemas/${groupBy}.schema.ts`),
          `${this.getImportsForSchemas(imports)}${this.addExportSchema(
            `Yup.object({ where: ${modelName}WhereInputObjectSchema, orderBy: ${modelName}OrderByWithAggregationInputObjectSchema, having: ${modelName}ScalarWhereWithAggregatesInputObjectSchema, take: Yup.number(), skip: Yup.number(), by: Yup.array().of(${modelName}ScalarFieldEnumSchema).required()  }).required()`,
            `${modelName}GroupBy`,
          )}`,
        );
        Transformer.generatedSchemaFiles.push(`./${groupBy}.schema`);
      }
    }
    await this.printHelpers();
  }

  async printEnumSchemas() {
    for (const enumType of this.enumTypes ?? []) {
      const { name, values } = enumType;

      await writeFileSafely(
        path.join(Transformer.outputPath, `schemas/enums/${name}.schema.ts`),
        `${this.getImportYup()}\n${this.addExportSchema(
          `Yup.mixed().oneOf(${JSON.stringify(values)})`,
          `${name}`,
        )}`,
      );
      Transformer.generatedSchemaEnumFiles.push(`./${name}.schema`);
      Transformer.internals.push(`./enums/${name}.schema`);
    }
  }

  async printIndex(type: 'SCHEMAS' | 'SCHEMA_OBJECTS' | 'SCHEMA_ENUMS') {
    const filesPaths =
      type === 'SCHEMAS'
        ? Transformer.generatedSchemaFiles
        : type === 'SCHEMA_ENUMS'
        ? Transformer.generatedSchemaEnumFiles
        : Transformer.generatedSchemaObjectFiles;
    const exports = filesPaths.map(
      (schemaPath) => `export * from '${schemaPath}';`,
    );

    const outputPath = path.join(
      Transformer.outputPath,
      type === 'SCHEMAS'
        ? `schemas/index.ts`
        : type === 'SCHEMA_ENUMS'
        ? `schemas/enums/index.ts`
        : `schemas/objects/index.ts`,
    );
    await writeFileSafely(outputPath, `${exports.join('\r\n')}`);
  }

  async printInternals() {
    let lastNestedIndex = -1;
    let itemsToMoveUp: Array<Array<string>> = [];
    const filesPaths = Transformer.internals.filter((item, i) => {
      if (item.includes('/objects/Nested')) {
        lastNestedIndex = i;
      }
      if (item.includes('Envelope')) {
        itemsToMoveUp.push([item]);
        return false;
      }
      return true;
    });

    itemsToMoveUp = itemsToMoveUp.map((item) => {
      const singleItem = item[0];
      const itemWithoutEnvelope = singleItem.replace('Envelope', '');
      const indexOfItem = filesPaths.indexOf(itemWithoutEnvelope);
      if (indexOfItem > -1) {
        const itemWithEnvelope = filesPaths[indexOfItem];
        filesPaths.splice(indexOfItem, 1);
        return [singleItem, itemWithEnvelope];
      }
      return item;
    });

    const itemsUptoNested = filesPaths.slice(0, lastNestedIndex + 1);
    const itemsAfterNested = filesPaths.slice(lastNestedIndex);

    let finalItems = itemsToMoveUp
      .map(([envelope, item]) => {
        return [item, envelope];
      })
      .flatMap((item) => item);

    finalItems = finalItems.concat(itemsAfterNested);
    finalItems = finalItems.concat(itemsUptoNested);

    const exports = finalItems.map(
      (schemaPath) => `export * from '${schemaPath}';`,
    );

    const outputPath = path.join(
      Transformer.outputPath,
      'schemas/internals.ts',
    );
    await writeFileSafely(outputPath, `${exports.join('\r\n')}`);
  }

  /**
   * Emits the `oneOfSchemas` helper as a plain exported function.
   *
   * This used to install a method onto yup's `MixedSchema` prototype with `Yup.addMethod`,
   * and the emitted schemas called it as `Yup.mixed().oneOfSchemas([...])`. Nothing ever
   * told TypeScript that method existed, so every one of those call sites was an error:
   * `Property 'oneOfSchemas' does not exist on type 'MixedSchema'`, 207 times in the
   * example output alone, which is most of why the emitted files need `// @ts-nocheck`.
   *
   * Declaring it was not a matter of finding the right `declare module 'yup'` block, and
   * that is worth writing down because several attempts at one silently did nothing. The
   * name `MixedSchema` that yup's entry point exports is a re-export of the *default*
   * export of `yup/lib/mixed`, and that default export is `declare const Mixed: typeof
   * MixedSchema` -- a value, with no type meaning at all. `type T = Yup.MixedSchema` is
   * itself an error: "refers to a value, but is being used as a type here". So an
   * `interface MixedSchema` inside `declare module 'yup'` has no class to merge with; it
   * just creates a new, unrelated interface, and TypeScript reports nothing. The class
   * lives in `yup/lib/mixed`, and augmenting that path does work, but it means declaring
   * against a private path into another package's internals.
   *
   * A plain function needs none of that. It is typed with yup's public types, it does not
   * mutate a shared prototype at import time, and it behaves identically: the old method
   * body was `this.test(...)` on a `Yup.mixed()` instance, which is exactly what this does.
   */
  async printHelpers() {
    await writeFileSafely(
      path.join(
        Transformer.outputPath,
        `schemas/helpers/oneOfSchemas.helper.ts`,
      ),
      `${this.getImportYup()}
/**
 * A schema that accepts a value matching at least one of \`schemas\`.
 *
 * An alternative is either an ordinary yup schema or a \`Yup.lazy\` wrapper around one,
 * because references between generated schemas are deferred with \`Yup.lazy\`. yup exports
 * no public name for that union, so it is spelled out here rather than reached for through
 * a deep import into yup's internals.
 */
export type OneOfSchemasAlternative = Yup.AnySchema | ReturnType<typeof Yup.lazy>;

export function oneOfSchemas(schemas: OneOfSchemasAlternative[]) {
  return Yup.mixed().test(
    'one-of-schemas',
    'Not all items in \${path} match one of the allowed schemas',
    (item) =>
      schemas.some((schema) => schema.isValidSync(item, { strict: true })),
  );
}
`,
    );
  }
}
