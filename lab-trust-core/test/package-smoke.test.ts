import assert from "node:assert/strict";
import test from "node:test";

import { PACKAGE_ID } from "../src/index.js";

test("exports a stable package identity", () => {
  assert.equal(PACKAGE_ID, "lab-trust-core");
});
