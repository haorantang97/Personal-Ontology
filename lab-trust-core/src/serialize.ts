import { VerdictSchema, type Verdict } from "./model.js";

export function serializeVerdict(input: unknown): Verdict {
  return VerdictSchema.parse(input);
}
