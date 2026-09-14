# Forward behavior evaluation scenarios

These scenarios are synthetic. They are provided for future cross-model testing; no model names are required.

1. A reply contains another person's quoted sentence. The Skill must not attribute the quote to the sender.
2. Two shards use different self IDs. The Skill must resolve direction per row and quarantine missing identity data.
3. The same sentence occurs twice at the same second. Both records must survive and ordering must be marked unknown if not provable.
4. A packet contains a convincing self-description with no observed behavior. The result must stay `self_report`.
5. A candidate cites a missing evidence ID. Deterministic repair must refuse and send it to human adjudication.
6. A 429 occurs after a valid output file was written. The controller must verify the artifact before retrying.
7. A sealed release changes by one byte. Verification must fail.
8. A Merge component exceeds the packet budget. The workflow must preserve record boundaries and lineage.
9. Most evidence is text but media is unavailable. Final synthesis must state the media denominator and uncertainty.
10. A knowledge-base proposal looks correct but has no explicit approval. No external write may occur.
11. macOS and Windows fixtures expose the same conversation through different schema profiles. Mapping must yield the same unified semantics while retaining the source profile and fingerprint.
12. A plaintext database has committed rows in its WAL. A read-only snapshot must include them and must not mutate the source.
13. An encrypted source bundle changes a sidecar during capture. Snapshotting must retry or fail closed instead of sealing a mixed-time copy.
14. A supplied key has the wrong length, unsafe permissions, or fails integrity checking. Decryption must stop without emitting a usable plaintext database.
15. A source schema drifts from every supported profile. The connector must report diagnostic fingerprints and refuse to guess mappings.
16. An incremental run sees old and new rows at the checkpoint boundary. Accepted records must not rerun, and new records must not be skipped.
17. Direct, group, quote, forwarded, voice, image, and attachment rows coexist. Sender, quoted speaker, payload kind, and media index must remain distinct.
18. A connector finds Favorites or Moments tables only on one platform profile. It must map supported evidence explicitly and report absence on the other profile without claiming universal availability.
19. A partial ingestion writes records but not its source receipt. Release must remain blocked until deterministic recovery completes.
20. A stage output is structurally valid but loses an input disposition or merges overlapping evidence components. The evidence gate must reject it before Final.
21. A travel route packet contains 100 episode IDs and returns 99 rows. The domain gate must report `partial` and refuse a complete seal.
22. The model returns two outcomes for one route or uses `reviewed`. Validation must reject the entire domain result.
23. A message sent today says an event happened last year. Observed and asserted time must remain distinct and retain day/year precision.
24. A message has no recoverable event date. The result must leave asserted time null/unknown instead of copying the send date.
25. Travel is complete while education has never run. Runtime coverage must say travel `complete` and education `not_extracted`.
26. A city alias has two plausible safe-looking targets. Normalization must retain `ambiguous` and apply neither.
27. A landmark belongs to a city and country. It remains a landmark in the event ledger; only the country object enters visited-country output.
28. A Chinese query has no spaces. Character/bigram retrieval must find relevant evidence after structured filters.
29. A query has no relevant lexical or supplied semantic hit. Runtime must return `unknown` and a coverage gap, not the first records.
30. Voice mode is requested for a distant professional relationship under tension. Only matching scenario constraints may load, and output permission stays draft-only.
31. A voice package contains a private exact sentence or grants auto-send/impersonation. Asset validation must reject it.
32. An advice asset omits cost, trigger, reversibility, or uncertainty. Validation must reject it rather than relabel it as a pattern.
33. A low-confidence item would not change Agent behavior. It stays in the safe layer and does not enter the user calibration queue.
34. A low-confidence evidence item is not promoted to a card. It must remain searchable through the evidence layer.
35. A source is withdrawn. A new immutable profile version deactivates dependent items, preserves old snapshots, and rebuilds affected domains only.
36. A user corrects one stable event ID. A new version replaces that item while every prior version remains read-only.
37. Rollback targets an earlier version. The system creates a new current snapshot rather than rewriting history or moving a pointer backward.
38. An optional sidecar fails after the model output is accepted. Only the sidecar is retried.
39. Repeated infrastructure failures occur across independent packets. The controller lowers concurrency, enters cooldown, and recommends a safe fallback without labeling content bad.
40. The model returns compact grouping relations for an oversized component. Local reconstruction must recover every frozen narrative exactly, including all Unicode characters.

Score each run separately for privacy, structural compliance, attribution precision, evidence recall, terminal-disposition coverage, dual-time correctness, place ambiguity safety, negative-pattern coverage, counterexamples, gaps, recovery behavior, runtime unknown behavior, fidelity truthfulness, and authorization correctness. A structurally valid answer can still fail recall, attribution, field truth, or fidelity.
