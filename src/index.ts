import { generatorHandler } from '@prisma/generator-helper';
import { generate } from './prisma-generator';

generatorHandler({
  onManifest: () => ({
    defaultOutput: 'node_modules/@generated/prisma-joi-generator',
    prettyName: 'Prisma Joi Generator',
    requiresGenerators: ['prisma-client-js'],
  }),
  onGenerate: generate,
});
