import { generatorHandler } from '@prisma/generator-helper';
import { generate } from './prisma-generator';

generatorHandler({
  onManifest: () => ({
    defaultOutput: './generated',
    prettyName: 'Prisma Yup Generator',
    requiresGenerators: ['prisma-client-js'],
  }),
  onGenerate: generate,
});
