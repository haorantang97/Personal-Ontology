# External Method Review and Clean-Room Decisions

Review date: 2026-08-22. Only default-branch public descriptions and license
metadata were inspected. No repository was cloned, imported, or used as a
runtime/build dependency.

| Reference | Observed license | Independently adopted idea | Explicitly rejected |
|---|---|---|---|
| [alchaincyf/nuwa-skill](https://github.com/alchaincyf/nuwa-skill) | MIT | Validate patterns across domains, on unseen cases, and against genericness; keep decision and expression permissions distinct; report limits | Prompts, agent layout, generated-person imitation, names, schemas, and wording |
| [wildbyteai/digital-life](https://github.com/wildbyteai/digital-life) | MIT | Portable life-story, decision/expression, boundary, evidence, and evaluation assets; incremental correction | Files, templates, schemas, prompts, directory structure, and narrative copy |
| [Tomsawyerhu/Persona-Skill](https://github.com/Tomsawyerhu/Persona-Skill) | No license visible at review time | Rich dimensions, source/evidence indexes, temporal evolution, minimal module loading | All code/text/layout; first-person role persistence and impersonation behavior |
| [wangqiaodan123/me.skill](https://github.com/wangqiaodan123/me.skill) | MIT | Separate life memory and behavioral layers; append, correct, and roll back as product operations | Templates, labels, parsers, prompts, and authorization to act as the person |
| [smota/personalOS](https://github.com/smota/personalOS) | GPL-3.0 | Local-first portable context and review before durable save | Code, file model, heavy runtime dependency, or GPL-derived implementation |
| [HeliosNova/nova](https://github.com/HeliosNova/nova) | Not relied on | Correction-aware retrieval and inspectable temporal memory as a general research direction | Code, service architecture, model/runtime assumptions, and compatibility claims |

## Independent product decisions

- Runtime modes are `biography`, `voice`, `advisor`, and `mixed`; none grants
  authority to impersonate, send, commit, or claim the user is indistinguishable.
- The complete event/evidence ledger is authority. Cards and runtime packs are
  removable indexes, not replacements.
- Retrieval is lightweight Python with structured and lexical filters. Optional
  semantic scores are caller-provided, so no vector database or model dependency
  is introduced.
- The v2 schemas, field names, state transitions, fixtures, and tests were derived
  from the source-task requirements and independently designed in this repo.

This page is an idea-provenance record, not a third-party license grant. The
project's custom publication/license draft still requires qualified legal review.
