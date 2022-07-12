# Prisma Yup Generator

[![npm version](https://badge.fury.io/js/prisma-yup-generator.svg)](https://badge.fury.io/js/prisma-yup-generator)
[![npm](https://img.shields.io/npm/dt/prisma-yup-generator.svg)](https://www.npmjs.com/package/prisma-yup-generator)
[![HitCount](https://hits.dwyl.com/omar-dulaimi/prisma-yup-generator.svg?style=flat)](http://hits.dwyl.com/omar-dulaimi/prisma-yup-generator)
[![npm](https://img.shields.io/npm/l/prisma-yup-generator.svg)](LICENSE)

Automatically generate [Yup](https://github.com/jquense/yup) schemas from your [Prisma](https://github.com/prisma/prisma) Schema, and use them to validate your API endpoints or any other use you have. Updates every time `npx prisma generate` runs.

<p align="center">
  <a href="https://www.buymeacoffee.com/omardulaimi">
    <img src="https://cdn.buymeacoffee.com/buttons/default-black.png" alt="Buy Me A Coffee" height="41" width="174">
  </a>
</p>

## Table of Contents

- [Supported Prisma Versions](#supported-prisma-versions)
- [Installation](#installing)
- [Usage](#usage)
- [Additional Options](#additional-options)

# Supported Prisma Versions

### Prisma 4

- 0.2.0 and higher

### Prisma 2/3

- 0.1.5 and lower

## Installation

Using npm:

```bash
 npm install prisma-yup-generator
```

Using yarn:

```bash
 yarn add prisma-yup-generator
```

# Usage

1- Star this repo 😉

2- Add the generator to your Prisma schema

```prisma
generator yup {
  provider = "prisma-yup-generator"
}
```

3- Running `npx prisma generate` for the following schema.prisma

```prisma
model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
  posts Post[]
}

model Post {
  id        Int      @id @default(autoincrement())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  title     String
  content   String?
  published Boolean  @default(false)
  viewCount Int      @default(0)
  author    User?    @relation(fields: [authorId], references: [id])
  authorId  Int?
}
```

will generate the following files

![Yup Schemas](https://raw.githubusercontent.com/omar-dulaimi/prisma-yup-generator/master/yupSchemas.png)

4- Use generated schemas somewhere in your API logic, like middleware or decorator

```ts
import { PostCreateOneSchema } from './prisma/generated/schemas';

app.post('/blog', async (req, res, next) => {
  const { body } = req;
  await PostCreateOneSchema.validate(body);
});
```

## Additional Options

| Option   |  Description                                   | Type     |  Default      |
| -------- | ---------------------------------------------- | -------- | ------------- |
| `output` | Output directory for the generated yup schemas | `string` | `./generated` |

Use additional options in the `schema.prisma`

```prisma
generator yup {
  provider   = "prisma-yup-generator"
  output     = "./generated-yup-schemas"
}
```
