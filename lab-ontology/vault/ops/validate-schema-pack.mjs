#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSchemaChanges } from "./gateway/schema-pack.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
console.log(JSON.stringify(validateSchemaChanges(root, [{ action: "schema" }]), null, 2));
