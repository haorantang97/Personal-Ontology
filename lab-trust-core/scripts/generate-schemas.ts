import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  KnowledgeRecordSchema,
  PolicySchema,
  VerdictSchema
} from "../src/model.js";

type JsonSchema = Record<string, unknown>;

function namedSchema(
  name: string,
  title: string,
  schema: z.ZodType
): JsonSchema {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12"
  }) as Record<string, unknown>;
  return {
    $id: `https://raw.githubusercontent.com/haorantang97/Personal-Ontology/main/lab-trust-core/schemas/${name}.schema.json`,
    title,
    ...generated
  };
}

export function generateSchemas(): Record<string, JsonSchema> {
  return {
    "knowledge-record": namedSchema(
      "knowledge-record",
      "Knowledge Trust Record",
      KnowledgeRecordSchema
    ),
    verdict: namedSchema("verdict", "Knowledge Use Verdict", VerdictSchema),
    policy: namedSchema("policy", "Knowledge Trust Policy", PolicySchema)
  };
}

export async function writeSchemas(directory = "schemas"): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, schema] of Object.entries(generateSchemas())) {
    await writeFile(
      path.join(directory, `${name}.schema.json`),
      `${JSON.stringify(schema, null, 2)}\n`,
      "utf8"
    );
  }
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  await writeSchemas();
}
