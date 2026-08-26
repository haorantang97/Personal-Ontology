import type { Verdict } from "./model.js";

type Locale = "en" | "zh-CN";

const messages: Record<string, Record<Locale, string>> = {
  EXPLICITLY_DISALLOWED: {
    en: "The record or claim explicitly prohibits this use.",
    "zh-CN": "该记录或 Claim 明确禁止这一用途。"
  },
  USE_NOT_DECLARED_ALLOWED: {
    en: "A non-empty allowed-use list does not include the requested use.",
    "zh-CN": "非空允许用途白名单未包含本次请求用途。"
  },
  SOURCE_NOT_DEFAULT_SURFACE: {
    en: "Source evidence is not a default answer or decision surface.",
    "zh-CN": "Source 证据层不能直接作为默认回答或决策表面。"
  },
  HIGH_RISK_REQUIRES_VALIDATED: {
    en: "High-risk use requires validated maturity.",
    "zh-CN": "高风险用途要求 validated 成熟度。"
  },
  MATURITY_TOO_LOW: {
    en: "The record is not mature enough for the requested use.",
    "zh-CN": "该记录的成熟度不足以支持所请求的用途。"
  },
  CLAIM_TYPE_NOT_ALLOWED: {
    en: "This claim type is not allowed for the requested use.",
    "zh-CN": "该 Claim 类型不允许用于所请求的用途。"
  },
  SCOPE_MISMATCH: {
    en: "The requested scope is outside the record's declared scope.",
    "zh-CN": "请求范围超出了该记录声明的适用范围。"
  },
  SEED_LIMITED_USE: {
    en: "Seed knowledge may be used only within its declared low-confidence boundary.",
    "zh-CN": "seed 知识只能在声明的低置信边界内使用。"
  },
  ATTRIBUTION_REQUIRED: {
    en: "This use requires attribution to the source boundary.",
    "zh-CN": "这一用途必须标注来源与证据边界。"
  },
  EVIDENCE_GAPS_PRESENT: {
    en: "Known evidence gaps must remain visible.",
    "zh-CN": "已知证据缺口必须保持可见。"
  },
  POLICY_ALLOWED: {
    en: "The active policy permits this use within the declared scope.",
    "zh-CN": "现行政策允许在声明范围内进行这一用途。"
  }
};

export function explainReasonCodes(reasonCodes: string[], locale: Locale): string {
  return reasonCodes
    .map((code) => messages[code]?.[locale] ?? code)
    .join(" ");
}

export function explainVerdict(verdict: Verdict, locale: Locale = "en"): Verdict {
  return {
    ...verdict,
    explanation: explainReasonCodes(verdict.reason_codes, locale)
  };
}
