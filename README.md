# Prisma Joi Generator

[![npm version](https://badge.fury.io/js/prisma-joi-generator.svg)](https://badge.fury.io/js/prisma-joi-generator)
[![npm](https://img.shields.io/npm/dt/prisma-joi-generator.svg)](https://www.npmjs.com/package/prisma-joi-generator)
[![HitCount](https://hits.dwyl.com/omar-dulaimi/prisma-joi-generator.svg?style=flat)](http://hits.dwyl.com/omar-dulaimi/prisma-joi-generator)
[![npm](https://img.shields.io/npm/l/prisma-joi-generator.svg)](LICENSE)

Automatically generate [Joi](https://joi.dev/api) schemas from your [Prisma](https://github.com/prisma/prisma) Schema, and use them to validate your API endpoints or any other use you have. Updates every time `npx prisma generate` runs.

## Table of Contents

- [Installation](#installing)
- [Usage](#usage)
- [Additional Options](#additional-options)

## Installation

Using npm:

```bash
 npm install prisma-joi-generator
```

Using yarn:

```bash
 yarn add prisma-joi-generator
```

# Usage

1- Add the generator to you Prisma schema

```prisma
generator joi {
  provider = "prisma-joi-generator"
}
```

2- Running `npx prisma generate` for the following [schema.prisma](https://github.com/omar-dulaimi/prisma-joi-generator/blob/master/prisma/schema.prisma)

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

![Joi Schemas](https://raw.githubusercontent.com/omar-dulaimi/prisma-joi-generator/master/joiSchemas.png)


4- Use generated schemas somewhere in your API logic, like middleware or decorator

```ts
import Joi from "joi";
import createOnePostSchema from "./prisma/generated/schemas/createOnePost.schema.ts";

app.post('/blog', async (req, res, next) => { 
  const { body } = req; 
  const result = Joi.validate(body, createOnePostSchema); 
});
```

## Additional Options

| Option                |  Description                                    | Type      |  Default      |
| --------------------- | ----------------------------------------------- | --------- | ------------- |
| `output`              | Output directory for the generated joi schemas  | `string`  | `./generated` |


Use additional options in the `schema.prisma`

```prisma
generator joi {
  provider   = "prisma-joi-generator"
  output     = "./generated-joi-schemas"
}
```
