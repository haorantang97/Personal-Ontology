#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

from personal_context_distillation.authorization import AuthorizationStore
from personal_context_distillation.compact_merge import reconstruct_grouped_candidates
from personal_context_distillation.contract_bundle import validate_contract_bundle
from personal_context_distillation.connectors import (
    discover_wechat4_candidates,
    run_external_decryptor,
    run_local_key_provider,
    snapshot_sqlite,
)
from personal_context_distillation.pipeline import PCDCase
from personal_context_distillation.process_monitor import TaskProcessMonitor
from personal_context_distillation.atomic import read_json, write_json
from personal_context_distillation.controller import (
    AdaptiveController,
    freeze_run_scope,
    freeze_runtime_policy,
    observe_run_scope,
)
from personal_context_distillation.domain_routing import freeze_domain_packet, validate_domain_result
from personal_context_distillation.transport import probe_contract
from personal_context_distillation.field_evidence import validate_field_evidence
from personal_context_distillation.life_events import build_life_ledger, merge_domain_ledgers
from personal_context_distillation.personal_assets import validate_asset_package
from personal_context_distillation.places import normalize_places
from personal_context_distillation.portable import build_portable_package, freeze_portable_package
from personal_context_distillation.profile_history import ProfileHistory
from personal_context_distillation.runtime import query_runtime
from personal_context_distillation.wechat4.checkpoint import CheckpointStore
from personal_context_distillation.wechat4.crypto import decrypt_snapshot, read_key_file
from personal_context_distillation.wechat4.discovery import (
    discover_accounts,
    load_registered_account,
    persist_source_registry,
)
from personal_context_distillation.wechat4.mapping import map_snapshot
from personal_context_distillation.wechat4.snapshot import snapshot_account


def json_ready(value):
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {key: json_ready(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_ready(item) for item in value]
    return value


def emit(value) -> None:
    print(json.dumps(json_ready(value), ensure_ascii=False, sort_keys=True, indent=2))


def safe_name(value: str) -> str:
    if not value or any(character in value for character in ("/", "\\", "\x00")) or value in {".", ".."}:
        raise ValueError("name must be one safe path component")
    return value


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Deterministic local controller for personal context distillation")
    commands = root.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="initialize an isolated case directory")
    init.add_argument("case", type=Path)

    authorize = commands.add_parser("authorize", help="record an exact explicit authorization")
    authorize.add_argument("case", type=Path)
    authorize.add_argument("action", choices=["new_source", "local_key_access", "send_unredacted", "kb_write"])
    authorize.add_argument("--note", default="")

    for name in ("ingest-jsonl", "ingest-csv"):
        ingest = commands.add_parser(name, help=f"import a user-approved {name.removeprefix('ingest-').upper()} source")
        ingest.add_argument("case", type=Path)
        ingest.add_argument("input", type=Path)
        ingest.add_argument("--source-name", required=True)
    ingest_sqlite = commands.add_parser("ingest-sqlite", help="run a read-only SELECT against a user-approved plaintext SQLite snapshot")
    ingest_sqlite.add_argument("case", type=Path)
    ingest_sqlite.add_argument("input", type=Path)
    ingest_sqlite.add_argument("--source-name", required=True)
    ingest_sqlite.add_argument("--query", required=True)

    release = commands.add_parser("release", help="freeze an immutable redacted release")
    release.add_argument("case", type=Path)
    release.add_argument("generation")
    release.add_argument("--gap", action="append", default=[])

    plan = commands.add_parser("plan", help="split an immutable input into model-neutral stage packets")
    plan.add_argument("case", type=Path)
    plan.add_argument("stage", choices=["map", "merge", "final", "qa"])
    plan.add_argument("input", type=Path)
    plan.add_argument("--max-bytes", type=int, default=256_000)
    plan.add_argument("--instruction-file", type=Path)
    plan.add_argument("--depends", action="append", default=[])
    plan.add_argument("--candidate-set")

    claim = commands.add_parser("claim", help="reserve one work unit with a lease")
    claim.add_argument("case", type=Path)
    claim.add_argument("unit_id")
    claim.add_argument("worker_id")
    claim.add_argument("--lease-seconds", type=int, default=900)

    submit = commands.add_parser("submit", help="locally validate and commit a model result")
    submit.add_argument("case", type=Path)
    submit.add_argument("unit_id")
    submit.add_argument("result", type=Path)

    record = commands.add_parser("record-output", help="persist a model output without validating it")
    record.add_argument("case", type=Path)
    record.add_argument("unit_id")
    record.add_argument("result", type=Path)
    validate = commands.add_parser("validate", help="locally validate a produced output")
    validate.add_argument("case", type=Path)
    validate.add_argument("unit_id")
    commit = commands.add_parser("commit", help="commit a locally validated output")
    commit.add_argument("case", type=Path)
    commit.add_argument("unit_id")
    fail = commands.add_parser("fail", help="record a classified failure without conflating retry policy")
    fail.add_argument("case", type=Path)
    fail.add_argument("unit_id")
    fail.add_argument("category", choices=["infrastructure", "structure", "content", "privacy", "dependency"])
    fail.add_argument("--reason", required=True)

    adjudicate = commands.add_parser("adjudicate", help="record an explicit human decision")
    adjudicate.add_argument("case", type=Path)
    adjudicate.add_argument("unit_id")
    adjudicate.add_argument("decision", choices=["accept", "reject"])
    adjudicate.add_argument("--note", required=True)
    adjudicate.add_argument("--replacement", type=Path)

    status = commands.add_parser("status", help="report precise stage denominators and queues")
    status.add_argument("case", type=Path)

    materialize = commands.add_parser("materialize", help="materialize a fully accepted stage as derived JSONL")
    materialize.add_argument("case", type=Path)
    materialize.add_argument("stage", choices=["map", "merge", "final", "qa"])
    materialize.add_argument("output", type=Path)

    freeze_candidates = commands.add_parser("freeze-candidates", help="seal the exact candidate IDs used for final synthesis")
    freeze_candidates.add_argument("case", type=Path)
    freeze_candidates.add_argument("name")
    freeze_candidates.add_argument("input", type=Path)

    proposal = commands.add_parser("kb-propose", help="freeze a knowledge-base proposal without writing it")
    proposal.add_argument("case", type=Path)
    proposal.add_argument("entries", type=Path)
    approval = commands.add_parser("kb-approve", help="approve an exact proposal; no external write is performed")
    approval.add_argument("case", type=Path)
    approval.add_argument("proposal_id")

    snapshot = commands.add_parser("snapshot-sqlite", help="create a read-only, WAL-consistent local SQLite snapshot")
    snapshot.add_argument("source", type=Path)
    snapshot.add_argument("destination", type=Path)

    discover = commands.add_parser("discover", help="locally inspect standard WeChat 4.x candidate directories")
    discover.add_argument("platform", choices=["macos", "windows"])
    discover.add_argument("--home", type=Path)

    decrypt = commands.add_parser("decrypt-external", help="run user-installed key and decryptor adapters without persisting the key")
    decrypt.add_argument("case", type=Path)
    decrypt.add_argument("source", type=Path)
    decrypt.add_argument("destination", type=Path)
    decrypt.add_argument("--key-command-json", type=Path, required=True)
    decrypt.add_argument("--decrypt-command-json", type=Path, required=True)

    wechat_discover = commands.add_parser("wechat4-discover", help="discover and privately register a user-approved WeChat 4.x source")
    wechat_discover.add_argument("case", type=Path)
    wechat_discover.add_argument("platform", choices=["macos", "windows"])
    wechat_discover.add_argument("--home", type=Path)
    wechat_discover.add_argument("--root", type=Path, action="append", default=[])

    wechat_snapshot = commands.add_parser("wechat4-snapshot", help="snapshot every registered database for one WeChat account")
    wechat_snapshot.add_argument("case", type=Path)
    wechat_snapshot.add_argument("account_ref")
    wechat_snapshot.add_argument("name")

    wechat_decrypt = commands.add_parser("wechat4-decrypt", help="decrypt a WeChat snapshot with a separately authorized private key")
    wechat_decrypt.add_argument("case", type=Path)
    wechat_decrypt.add_argument("snapshot", type=Path)
    wechat_decrypt.add_argument("name")
    wechat_decrypt.add_argument("--key-file", type=Path, required=True)
    wechat_decrypt.add_argument("--sqlcipher-executable", default="sqlcipher")

    wechat_map = commands.add_parser("wechat4-map", help="map a plaintext WeChat 4.x snapshot into private and redacted case records")
    wechat_map.add_argument("case", type=Path)
    wechat_map.add_argument("snapshot", type=Path)
    wechat_map.add_argument("platform", choices=["macos", "windows"])
    wechat_map.add_argument("--self-file", type=Path, required=True)

    wechat_checkpoint = commands.add_parser("wechat4-checkpoint", help="advance an incremental checkpoint only after a sealed release")
    wechat_checkpoint.add_argument("case", type=Path)
    wechat_checkpoint.add_argument("mapping_id")
    wechat_checkpoint.add_argument("generation")

    recover = commands.add_parser("recover-results", help="validate and commit bound local outputs left by an interrupted transport")
    recover.add_argument("case", type=Path)

    recover_ingestions = commands.add_parser("recover-ingestions", help="complete an interrupted private WeChat mapping ingestion")
    recover_ingestions.add_argument("case", type=Path)

    refill = commands.add_parser("controller-refill", help="claim completion-driven work slots using current failure signals")
    refill.add_argument("case", type=Path)
    refill.add_argument("worker_prefix")
    refill.add_argument("--max-concurrency", type=int, required=True)
    refill.add_argument("--validator-backlog-limit", type=int, default=16)

    scope = commands.add_parser("scope-freeze", help="freeze a run scope and migration watermark")
    scope.add_argument("case", type=Path)
    scope.add_argument("name")
    scope.add_argument("generation")
    scope.add_argument("unit_id", nargs="+")

    scope_status = commands.add_parser("scope-status", help="record a precise drain observation for a frozen run scope")
    scope_status.add_argument("case", type=Path)
    scope_status.add_argument("name")

    policy = commands.add_parser("policy-freeze", help="freeze a model-neutral runtime policy for one run")
    policy.add_argument("case", type=Path)
    policy.add_argument("name")
    policy.add_argument("capability_tier", choices=["ordinary", "advanced", "mixed"])

    probe = commands.add_parser("transport-probe", help="run a local no-data output-contract probe")
    probe.add_argument("stage", choices=["map", "merge", "final", "qa"])

    process_sample = commands.add_parser("process-sample", help="sample every explicitly registered process owned by one run")
    process_sample.add_argument("case", type=Path)
    process_sample.add_argument("task_ref")
    process_sample.add_argument("platform", choices=["posix", "windows"])
    process_sample.add_argument("--pid", type=int, action="append", required=True)

    process_trend = commands.add_parser("process-trend", help="summarize the time window of registered process samples")
    process_trend.add_argument("case", type=Path)
    process_trend.add_argument("task_ref")
    process_trend.add_argument("platform", choices=["posix", "windows"])
    process_trend.add_argument("--pid", type=int, action="append", required=True)

    life_ledger = commands.add_parser("life-ledger-build", help="build a route-bound event ledger and coverage receipt")
    life_ledger.add_argument("route_results", type=Path)
    life_ledger.add_argument("denominators", type=Path)
    life_ledger.add_argument("evidence_allowlists", type=Path)
    life_ledger.add_argument("place_allowlists", type=Path)
    life_ledger.add_argument("output", type=Path)
    life_merge = commands.add_parser("life-ledger-merge", help="merge sealed independent domain ledgers into one life ledger")
    life_merge.add_argument("output", type=Path)
    life_merge.add_argument("ledgers", type=Path, nargs="+")

    domain_plan = commands.add_parser("domain-plan", help="freeze one domain's exact routed-episode denominator and output contract")
    domain_plan.add_argument("root", type=Path)
    domain_plan.add_argument("name")
    domain_plan.add_argument("domain", choices=[
        "travel", "education", "work", "relationship", "residence",
        "family", "health", "finance", "creation",
    ])
    domain_plan.add_argument("records", type=Path)
    domain_validate = commands.add_parser("domain-validate", help="validate complete processing results for a frozen domain packet")
    domain_validate.add_argument("packet", type=Path)
    domain_validate.add_argument("result", type=Path)
    domain_validate.add_argument("output", type=Path)

    place_normalize = commands.add_parser("places-normalize", help="apply only unique deterministic place mappings")
    place_normalize.add_argument("mentions", type=Path)
    place_normalize.add_argument("candidates", type=Path)
    place_normalize.add_argument("output", type=Path)

    merge_reconstruct = commands.add_parser("merge-reconstruct", help="reconstruct compact cloud grouping output from frozen candidates")
    merge_reconstruct.add_argument("groups", type=Path)
    merge_reconstruct.add_argument("candidates", type=Path)
    merge_reconstruct.add_argument("output", type=Path)

    package_build = commands.add_parser("package-build", help="build and seal a portable v2 runtime package")
    package_build.add_argument("ledger", type=Path)
    package_build.add_argument("places", type=Path)
    package_build.add_argument("evidence", type=Path)
    package_build.add_argument("assets", type=Path)
    package_build.add_argument("cards", type=Path)
    package_build.add_argument("output_root", type=Path)
    package_build.add_argument("name")

    runtime_query = commands.add_parser("runtime-query", help="retrieve a minimal grounded runtime evidence pack")
    runtime_query.add_argument("package", type=Path)
    runtime_query.add_argument("query")
    runtime_query.add_argument("--mode", choices=["biography", "voice", "advisor", "mixed"], required=True)
    runtime_query.add_argument("--filters", type=Path, required=True)
    runtime_query.add_argument("--semantic-scores", type=Path)
    runtime_query.add_argument("--include-module", action="append", default=[])
    runtime_query.add_argument("--limit", type=int, default=10)

    asset_validate = commands.add_parser("asset-validate", help="validate layered self, voice, permission, and fidelity assets")
    asset_validate.add_argument("package", type=Path)
    asset_validate.add_argument("evidence_ids", type=Path)

    profile_init = commands.add_parser("profile-init", help="create the first immutable profile-history snapshot")
    profile_init.add_argument("history", type=Path)
    profile_init.add_argument("profile", type=Path)
    profile_update = commands.add_parser("profile-update", help="append an incremental immutable profile version")
    profile_update.add_argument("history", type=Path)
    profile_update.add_argument("base_version")
    profile_update.add_argument("additions", type=Path)
    profile_correct = commands.add_parser("profile-correct", help="replace one item in a new immutable profile version")
    profile_correct.add_argument("history", type=Path)
    profile_correct.add_argument("base_version")
    profile_correct.add_argument("collection", choices=["sources", "events", "evidence", "assets"])
    profile_correct.add_argument("item_id")
    profile_correct.add_argument("replacement", type=Path)
    profile_correct.add_argument("--reason", required=True)
    profile_withdraw = commands.add_parser("profile-withdraw", help="deactivate one source in a new immutable profile version")
    profile_withdraw.add_argument("history", type=Path)
    profile_withdraw.add_argument("base_version")
    profile_withdraw.add_argument("source_id")
    profile_withdraw.add_argument("--reason", required=True)
    profile_reextract = commands.add_parser("profile-reextract", help="replace one domain extraction in a new immutable version")
    profile_reextract.add_argument("history", type=Path)
    profile_reextract.add_argument("base_version")
    profile_reextract.add_argument("domain")
    profile_reextract.add_argument("events", type=Path)
    profile_reextract.add_argument("coverage", type=Path)
    profile_rollback = commands.add_parser("profile-rollback", help="copy a prior snapshot into a new immutable rollback version")
    profile_rollback.add_argument("history", type=Path)
    profile_rollback.add_argument("base_version")
    profile_rollback.add_argument("target_version")
    profile_rollback.add_argument("--reason", required=True)

    field_validate = commands.add_parser("field-evidence-validate", help="validate public aggregate field-evidence denominators")
    field_validate.add_argument("input", type=Path)
    contract_validate = commands.add_parser("contract-validate", help="validate the immutable real-distillation contract bundle")
    contract_validate.add_argument("contract_root", type=Path)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "init":
            case = PCDCase.initialize(args.case)
            emit({"case": case.root, "status": "initialized"})
        elif args.command == "authorize":
            emit(AuthorizationStore(args.case).grant(args.action, args.note))
        elif args.command in {"ingest-jsonl", "ingest-csv", "ingest-sqlite"}:
            case = PCDCase(args.case)
            if args.command == "ingest-jsonl":
                emit(case.ingest_jsonl(args.input, args.source_name))
            elif args.command == "ingest-csv":
                emit(case.ingest_csv(args.input, args.source_name))
            else:
                emit(case.ingest_sqlite(args.input, args.query, args.source_name))
        elif args.command == "release":
            case = PCDCase(args.case)
            path = case.freeze_release(args.generation, gaps=args.gap)
            emit({"release": path, "status": "sealed"})
        elif args.command == "plan":
            instruction = args.instruction_file.read_text(encoding="utf-8") if args.instruction_file else None
            emit(PCDCase(args.case).plan_stage(args.stage, args.input, args.max_bytes, instruction, args.depends, args.candidate_set))
        elif args.command == "claim":
            claimed = PCDCase(args.case).claim(args.unit_id, args.worker_id, args.lease_seconds)
            emit({"unit_id": args.unit_id, "claimed": claimed})
        elif args.command == "submit":
            candidates = json.loads(args.result.read_text(encoding="utf-8"))
            emit(PCDCase(args.case).submit_result(args.unit_id, candidates))
        elif args.command == "record-output":
            candidates = json.loads(args.result.read_text(encoding="utf-8"))
            emit(PCDCase(args.case).record_result(args.unit_id, candidates))
        elif args.command == "validate":
            emit(PCDCase(args.case).validate_result(args.unit_id))
        elif args.command == "commit":
            emit(PCDCase(args.case).commit_result(args.unit_id))
        elif args.command == "fail":
            case = PCDCase(args.case)
            case.ledger.fail(args.unit_id, args.category, args.reason)
            emit({"unit_id": args.unit_id, "status": case.ledger.state(args.unit_id)["status"]})
        elif args.command == "adjudicate":
            replacements = json.loads(args.replacement.read_text(encoding="utf-8")) if args.replacement else None
            emit(PCDCase(args.case).adjudicate(args.unit_id, args.decision, args.note, replacements))
        elif args.command == "status":
            emit(PCDCase(args.case).status())
        elif args.command == "materialize":
            emit(PCDCase(args.case).materialize_accepted(args.stage, args.output))
        elif args.command == "freeze-candidates":
            emit(PCDCase(args.case).freeze_candidates(args.name, args.input))
        elif args.command == "kb-propose":
            emit(PCDCase(args.case).create_kb_proposal(json.loads(args.entries.read_text(encoding="utf-8"))))
        elif args.command == "kb-approve":
            emit(PCDCase(args.case).approve_kb_proposal(args.proposal_id))
        elif args.command == "snapshot-sqlite":
            emit(snapshot_sqlite(args.source, args.destination))
        elif args.command == "discover":
            result = discover_wechat4_candidates(args.platform, args.home)
            emit({key: value for key, value in result.items() if key != "database_candidates"})
        elif args.command == "decrypt-external":
            authorizations = AuthorizationStore(args.case)
            key_command = json.loads(args.key_command_json.read_text(encoding="utf-8"))
            decrypt_command = json.loads(args.decrypt_command_json.read_text(encoding="utf-8"))
            key, key_receipt = run_local_key_provider(key_command, authorizations)
            decrypt_receipt = run_external_decryptor(decrypt_command, args.source, args.destination, key, authorizations)
            key = ""
            emit({"key_provider": key_receipt, "decryptor": decrypt_receipt})
        elif args.command == "wechat4-discover":
            case = PCDCase(args.case)
            case.authorizations.require("new_source")
            report = discover_accounts(args.platform, home=args.home, roots=args.root)
            emit(persist_source_registry(case.root, report))
        elif args.command == "wechat4-snapshot":
            case = PCDCase(args.case)
            account = load_registered_account(case.root, args.account_ref)
            destination = case.root / "local" / "wechat4-snapshots" / safe_name(args.name)
            receipt = snapshot_account(account, destination)
            emit({"account_ref": receipt["account_ref"], "database_count": len(receipt["databases"]),
                  "snapshot_seal": receipt["seal"], "status": "snapshotted"})
        elif args.command == "wechat4-decrypt":
            case = PCDCase(args.case)
            receipt = read_json(args.snapshot / "snapshot.json")
            key, key_receipt = read_key_file(args.key_file, case.authorizations)
            destination = case.root / "local" / "wechat4-decrypted" / safe_name(args.name)
            output = decrypt_snapshot(args.snapshot, receipt, destination, key, case.authorizations,
                                      executable=args.sqlcipher_executable)
            key = ""
            emit({"account_ref": output["account_ref"], "database_count": len(output["databases"]),
                  "snapshot_seal": output["seal"], "key_provider": key_receipt, "status": "decrypted"})
        elif args.command == "wechat4-map":
            case = PCDCase(args.case)
            case.authorizations.require("new_source")
            receipt = read_json(args.snapshot / "snapshot.json")
            identity = case.read_private_identity(args.self_file)
            account = load_registered_account(case.root, receipt["account_ref"])
            checkpoint = CheckpointStore(case.root, receipt["account_ref"]).load()
            mapping = map_snapshot(args.snapshot, receipt, args.platform, identity,
                                   [Path(path) for path in account.get("media_roots", [])], checkpoint=checkpoint)
            identity = ""
            if not mapping["records"]:
                emit({"account_ref": receipt["account_ref"], "record_count": 0, "status": "no_new_records"})
            else:
                summary = case.ingest_wechat4_mapping(mapping)
                emit({**summary, "optional_capabilities": mapping["optional_capabilities"], "status": "mapped_private"})
        elif args.command == "wechat4-checkpoint":
            emit(PCDCase(args.case).commit_wechat4_checkpoint(args.mapping_id, args.generation))
        elif args.command == "recover-results":
            emit(PCDCase(args.case).recover_results())
        elif args.command == "recover-ingestions":
            emit(PCDCase(args.case).recover_ingestions())
        elif args.command == "controller-refill":
            controller = AdaptiveController(PCDCase(args.case), args.max_concurrency, args.validator_backlog_limit)
            emit(controller.refill(args.worker_prefix))
        elif args.command == "scope-freeze":
            emit(freeze_run_scope(args.case, safe_name(args.name), args.unit_id, args.generation))
        elif args.command == "scope-status":
            case = PCDCase(args.case)
            emit(observe_run_scope(case.root, safe_name(args.name), case.ledger.states()))
        elif args.command == "policy-freeze":
            emit(freeze_runtime_policy(args.case, safe_name(args.name), {
                "semantic_model": "current_user_model", "capability_tier": args.capability_tier,
                "dynamic_concurrency": True, "fast_mode": False,
            }))
        elif args.command == "transport-probe":
            emit(probe_contract(args.stage))
        elif args.command == "process-sample":
            emit(TaskProcessMonitor(args.case, safe_name(args.task_ref), args.pid, args.platform).sample())
        elif args.command == "process-trend":
            emit(TaskProcessMonitor(args.case, safe_name(args.task_ref), args.pid, args.platform).trend())
        elif args.command == "life-ledger-build":
            ledger = build_life_ledger(
                read_json(args.route_results), read_json(args.denominators),
                read_json(args.evidence_allowlists), read_json(args.place_allowlists),
            )
            write_json(args.output, ledger)
            emit({
                "output": args.output, "route_count": ledger["route_count"],
                "event_count": ledger["event_count"], "coverage": ledger["coverage"], "seal": ledger["seal"],
            })
        elif args.command == "life-ledger-merge":
            ledger = merge_domain_ledgers([read_json(path) for path in args.ledgers])
            write_json(args.output, ledger)
            emit({
                "output": args.output, "route_count": ledger["route_count"],
                "event_count": ledger["event_count"],
                "combined_domain_count": ledger["combined_domain_count"], "seal": ledger["seal"],
            })
        elif args.command == "domain-plan":
            packet = freeze_domain_packet(args.root, safe_name(args.name), args.domain, read_json(args.records))
            emit({"domain": args.domain, "route_count": len(packet["route_ids"]), "packet_seal": packet["seal"]})
        elif args.command == "domain-validate":
            ledger = validate_domain_result(read_json(args.packet), read_json(args.result))
            write_json(args.output, ledger)
            emit({
                "output": args.output, "route_count": ledger["route_count"],
                "event_count": ledger["event_count"], "coverage": ledger["coverage"], "seal": ledger["seal"],
            })
        elif args.command == "places-normalize":
            places = normalize_places(read_json(args.mentions), read_json(args.candidates))
            write_json(args.output, places)
            emit({
                "output": args.output,
                "mention_count": len(places),
                "applied": sum(place["status"] == "applied" for place in places),
                "ambiguous": sum(place["status"] == "ambiguous" for place in places),
            })
        elif args.command == "merge-reconstruct":
            candidates = reconstruct_grouped_candidates(read_json(args.groups), read_json(args.candidates))
            write_json(args.output, candidates)
            emit({"output": args.output, "group_count": len(candidates), "status": "reconstructed_locally"})
        elif args.command == "package-build":
            package = build_portable_package(
                read_json(args.ledger), read_json(args.places), read_json(args.evidence),
                read_json(args.assets), read_json(args.cards),
            )
            emit(freeze_portable_package(args.output_root, safe_name(args.name), package))
        elif args.command == "runtime-query":
            scores = read_json(args.semantic_scores) if args.semantic_scores else None
            emit(query_runtime(
                read_json(args.package), args.query, mode=args.mode, filters=read_json(args.filters),
                semantic_scores=scores, include_modules=args.include_module, limit=args.limit,
            ))
        elif args.command == "asset-validate":
            evidence_ids = read_json(args.evidence_ids)
            if not isinstance(evidence_ids, list):
                raise ValueError("evidence_ids file must contain a JSON list")
            emit(validate_asset_package(read_json(args.package), set(evidence_ids)))
        elif args.command == "profile-init":
            emit(ProfileHistory(args.history).initialize(read_json(args.profile)))
        elif args.command == "profile-update":
            emit(ProfileHistory(args.history).incremental_update(args.base_version, read_json(args.additions)))
        elif args.command == "profile-correct":
            emit(ProfileHistory(args.history).correct(
                args.base_version, args.collection, args.item_id, read_json(args.replacement), reason=args.reason,
            ))
        elif args.command == "profile-withdraw":
            emit(ProfileHistory(args.history).withdraw_source(args.base_version, args.source_id, reason=args.reason))
        elif args.command == "profile-reextract":
            emit(ProfileHistory(args.history).reextract_domain(
                args.base_version, args.domain, read_json(args.events), coverage=read_json(args.coverage),
            ))
        elif args.command == "profile-rollback":
            emit(ProfileHistory(args.history).rollback(
                args.base_version, args.target_version, reason=args.reason,
            ))
        elif args.command == "field-evidence-validate":
            emit(validate_field_evidence(read_json(args.input)))
        elif args.command == "contract-validate":
            emit(validate_contract_bundle(args.contract_root))
        return 0
    except (RuntimeError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
