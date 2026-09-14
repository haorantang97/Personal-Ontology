from copy import deepcopy

from .hashing import digest_object


class AssetContractError(RuntimeError):
    pass


LAYERS = {"observation", "pattern", "hypothesis", "advice"}
CONFIDENCE = {"low", "medium", "high"}
EVALUATIONS = {"cross_domain_reproduction", "holdout_prediction", "non_generic_distinctiveness"}
EVALUATION_STATUSES = {"not_run", "required", "in_progress", "passed", "failed"}
EVALUATION_CASE_KINDS = EVALUATIONS | {"voice_blind_review"}
EVALUATION_SPLITS = {"development", "holdout", "blind"}
EVALUATION_CASE_FIELDS = {
    "case_id", "evaluation", "split", "status", "evidence_ids", "input_ref",
    "expected_behavior", "observed_behavior",
}
SCENARIO_FIELDS = {
    "scenario_id",
    "relationship_distance",
    "emotional_temperature",
    "purpose",
    "length",
    "humor_conditions",
    "profanity_boundary",
    "correction_style",
    "burst_rhythm",
    "redacted_features",
    "private_vault_refs",
    "evidence_ids",
}


def _string_list(value: object, field: str, *, allow_empty: bool = True) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise AssetContractError(f"{field} must be a string list")
    if not allow_empty and not value:
        raise AssetContractError(f"{field} cannot be empty")
    if len(value) != len(set(value)):
        raise AssetContractError(f"{field} contains duplicates")
    return value


def _validate_evidence(value: object, valid: set[str], field: str = "evidence_ids") -> list[str]:
    evidence = _string_list(value, field, allow_empty=False)
    missing = sorted(set(evidence) - valid)
    if missing:
        raise AssetContractError(f"unknown evidence: {missing}")
    return evidence


def _validate_claim(claim: dict, valid_evidence_ids: set[str]) -> None:
    common = {
        "asset_id", "layer", "statement", "domain_scope", "evidence_ids", "confidence",
        "counterexamples", "time_evolution", "unresolved_tensions", "calibration",
    }
    missing = common - set(claim)
    if missing:
        raise AssetContractError(f"self-model fields missing: {sorted(missing)}")
    if claim["layer"] not in LAYERS:
        raise AssetContractError("self-model layer is invalid")
    if claim["confidence"] not in CONFIDENCE:
        raise AssetContractError("self-model confidence is invalid")
    for field in ("asset_id", "statement"):
        if not isinstance(claim[field], str) or not claim[field].strip():
            raise AssetContractError(f"{field} must be non-empty")
    _string_list(claim["domain_scope"], "domain_scope", allow_empty=False)
    _validate_evidence(claim["evidence_ids"], valid_evidence_ids)
    for field in ("counterexamples", "time_evolution", "unresolved_tensions"):
        _string_list(claim[field], field)
    calibration = claim["calibration"]
    if not isinstance(calibration, dict) or set(calibration) != {"behavior_change", "status"}:
        raise AssetContractError("calibration must contain behavior_change and status")
    if not isinstance(calibration["behavior_change"], bool) or calibration["status"] not in {"safe_layer", "draft", "ready", "resolved"}:
        raise AssetContractError("calibration state is invalid")
    if claim["layer"] == "hypothesis" and not isinstance(claim.get("uncertainty"), str):
        raise AssetContractError("hypothesis requires uncertainty")
    if claim["layer"] == "advice":
        for field in ("benefit", "cost", "trigger", "reversibility", "uncertainty"):
            if not isinstance(claim.get(field), str) or not claim[field].strip():
                raise AssetContractError(f"advice requires {field}")


def _validate_voice(voice: object, valid_evidence_ids: set[str]) -> str:
    if not isinstance(voice, dict) or set(voice) != {"scenarios", "blind_review"}:
        raise AssetContractError("voice must contain scenarios and blind_review")
    scenarios = voice["scenarios"]
    if not isinstance(scenarios, list) or not scenarios:
        raise AssetContractError("voice scenarios cannot be empty")
    scenario_ids = set()
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            raise AssetContractError("voice scenario must be an object")
        forbidden = [key for key in scenario if "exact" in key.casefold() or "verbatim" in key.casefold() or "quote" in key.casefold()]
        if forbidden:
            raise AssetContractError("portable voice assets cannot contain exact private examples")
        missing = SCENARIO_FIELDS - set(scenario)
        if missing:
            raise AssetContractError(f"voice scenario fields missing: {sorted(missing)}")
        scenario_id = scenario["scenario_id"]
        if not isinstance(scenario_id, str) or not scenario_id or scenario_id in scenario_ids:
            raise AssetContractError("scenario_id must be non-empty and unique")
        scenario_ids.add(scenario_id)
        for field in SCENARIO_FIELDS - {"redacted_features", "private_vault_refs", "evidence_ids"}:
            if not isinstance(scenario[field], str) or not scenario[field].strip():
                raise AssetContractError(f"voice scenario requires {field}")
        _string_list(scenario["redacted_features"], "redacted_features", allow_empty=False)
        _string_list(scenario["private_vault_refs"], "private_vault_refs")
        _validate_evidence(scenario["evidence_ids"], valid_evidence_ids)
    review = voice["blind_review"]
    if not isinstance(review, dict) or set(review) != {"required", "status", "reviewer_count"}:
        raise AssetContractError("blind_review shape is invalid")
    if review["required"] is not True or review["status"] not in EVALUATION_STATUSES:
        raise AssetContractError("blind review must remain required with an honest status")
    if not isinstance(review["reviewer_count"], int) or isinstance(review["reviewer_count"], bool) or review["reviewer_count"] < 0:
        raise AssetContractError("blind review reviewer_count is invalid")
    if review["status"] == "passed" and review["reviewer_count"] <= 0:
        raise AssetContractError("passed blind review requires a reviewer")
    return review["status"]


def _validate_permissions(permissions: object) -> None:
    expected = {
        "biography": "describe_with_coverage",
        "voice": "draft_only",
        "advisor": "recommend_with_tradeoffs",
        "auto_send": False,
        "impersonate": False,
        "irreversible_commitment": False,
        "claim_indistinguishable": False,
    }
    if permissions != expected:
        raise AssetContractError("runtime permissions exceed the safe contract")


def _validate_fidelity(fidelity: object, blind_status: str) -> bool:
    if not isinstance(fidelity, dict) or set(fidelity) != {"independent_from_content_qa", "evaluations", "field_claim"}:
        raise AssetContractError("fidelity shape is invalid")
    if fidelity["independent_from_content_qa"] is not True or not isinstance(fidelity["field_claim"], bool):
        raise AssetContractError("fidelity independence and field_claim must be explicit")
    evaluations = fidelity["evaluations"]
    if not isinstance(evaluations, dict) or set(evaluations) != EVALUATIONS:
        raise AssetContractError("fidelity evaluation set is incomplete")
    all_passed = True
    for name, evaluation in evaluations.items():
        if not isinstance(evaluation, dict) or set(evaluation) != {"status", "cases"}:
            raise AssetContractError(f"fidelity evaluation shape is invalid: {name}")
        if evaluation["status"] not in EVALUATION_STATUSES:
            raise AssetContractError(f"fidelity evaluation status is invalid: {name}")
        if not isinstance(evaluation["cases"], int) or isinstance(evaluation["cases"], bool) or evaluation["cases"] < 0:
            raise AssetContractError(f"fidelity cases are invalid: {name}")
        if evaluation["status"] == "passed" and evaluation["cases"] <= 0:
            raise AssetContractError(f"passed fidelity evaluation has no cases: {name}")
        all_passed = all_passed and evaluation["status"] == "passed"
    if fidelity["field_claim"] and (not all_passed or blind_status != "passed"):
        raise AssetContractError("field fidelity claim requires every evaluation and blind review to pass")
    return fidelity["field_claim"]


def _validate_evaluation_cases(cases: object, valid_evidence_ids: set[str]) -> int:
    if not isinstance(cases, list) or not cases:
        raise AssetContractError("evaluation_cases cannot be empty")
    case_ids = set()
    split_evidence = {"development": set(), "holdout": set(), "blind": set()}
    for case in cases:
        if not isinstance(case, dict) or set(case) != EVALUATION_CASE_FIELDS:
            raise AssetContractError("evaluation case shape is invalid or contains a private field")
        case_id = case["case_id"]
        if not isinstance(case_id, str) or not case_id or case_id in case_ids:
            raise AssetContractError("evaluation case_id must be non-empty and unique")
        case_ids.add(case_id)
        if case["evaluation"] not in EVALUATION_CASE_KINDS:
            raise AssetContractError("evaluation case kind is invalid")
        split = case["split"]
        if split not in EVALUATION_SPLITS:
            raise AssetContractError("evaluation case split is invalid")
        status = case["status"]
        if status not in EVALUATION_STATUSES:
            raise AssetContractError("evaluation case status is invalid")
        evidence_ids = _validate_evidence(case["evidence_ids"], valid_evidence_ids)
        split_evidence[split].update(evidence_ids)
        input_ref = case["input_ref"]
        if (
            not isinstance(input_ref, str) or not input_ref or len(input_ref) > 200
            or any(character in input_ref for character in ("/", "\\", "\n", "\r", "\x00"))
        ):
            raise AssetContractError("evaluation input_ref must be an opaque portable reference")
        if not isinstance(case["expected_behavior"], str) or not case["expected_behavior"].strip():
            raise AssetContractError("evaluation expected_behavior is required")
        observed = case["observed_behavior"]
        if status in {"passed", "failed"}:
            if not isinstance(observed, str) or not observed.strip():
                raise AssetContractError("completed evaluation case requires observed_behavior")
        elif observed is not None:
            raise AssetContractError("unrun evaluation case cannot claim observed_behavior")
    if split_evidence["development"].intersection(split_evidence["holdout"]):
        raise AssetContractError("development and holdout evaluation evidence must be disjoint")
    return len(cases)


def validate_asset_package(package: dict, valid_evidence_ids: set[str]) -> dict:
    if not isinstance(package, dict):
        raise AssetContractError("asset package must be an object")
    required = {"self_model", "voice", "permissions", "fidelity", "evaluation_cases"}
    if not required.issubset(package):
        raise AssetContractError(f"asset package fields missing: {sorted(required - set(package))}")
    claims = package["self_model"]
    if not isinstance(claims, list) or not claims:
        raise AssetContractError("self_model cannot be empty")
    ids = set()
    for claim in claims:
        if not isinstance(claim, dict):
            raise AssetContractError("self-model claim must be an object")
        _validate_claim(claim, valid_evidence_ids)
        if claim["asset_id"] in ids:
            raise AssetContractError("asset_id must be unique")
        ids.add(claim["asset_id"])
    blind_status = _validate_voice(package["voice"], valid_evidence_ids)
    _validate_permissions(package["permissions"])
    field_claim = _validate_fidelity(package["fidelity"], blind_status)
    evaluation_case_count = _validate_evaluation_cases(package["evaluation_cases"], valid_evidence_ids)
    return {
        "schema_version": "pcd-asset-validation/v2",
        "valid": True,
        "asset_count": len(claims),
        "blind_review_status": blind_status,
        "field_fidelity_claim": field_claim,
        "evaluation_case_count": evaluation_case_count,
        "package_hash": digest_object(package),
    }


def calibration_queue(claims: list[dict]) -> list[dict]:
    return [
        deepcopy(claim)
        for claim in claims
        if isinstance(claim.get("calibration"), dict)
        and claim["calibration"].get("behavior_change") is True
        and claim["calibration"].get("status") == "ready"
    ]


def build_knowledge_cards(claims: list[dict], valid_evidence_ids: set[str]) -> dict:
    cards = []
    not_promoted = []
    for claim in claims:
        _validate_claim(claim, valid_evidence_ids)
        if claim["confidence"] == "high":
            card = {
                "schema_version": "pcd-knowledge-card/v2",
                "card_id": "card_" + digest_object({"asset_id": claim["asset_id"], "evidence_ids": claim["evidence_ids"]})[:20],
                "source_asset_id": claim["asset_id"],
                "statement": claim["statement"],
                "domain_scope": deepcopy(claim["domain_scope"]),
                "confidence": "high",
                "evidence_ids": deepcopy(claim["evidence_ids"]),
                "index_only": True,
            }
            cards.append(card)
        else:
            not_promoted.append(claim["asset_id"])
    return {
        "cards": cards,
        "not_promoted": not_promoted,
        "retained_assets": deepcopy(claims),
    }
