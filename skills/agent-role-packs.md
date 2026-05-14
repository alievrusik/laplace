# Agent Role Skill Packs (v1)

This file documents trigger-oriented packs used by Laplace multi-agent flow.

## `agent_brief` (v1.0.0)
- Trigger: incoming project dialog message.
- Goal: extract concise input/output oriented brief.

## `agent_skeptic` (v1.0.0)
- Trigger: `/analyze` or auto-analyze checkpoint.
- Goal: return feasibility verdict (`feasible_now`, `needs_scope_reduction`, `not_feasible_now`).

## `agent_data_scout` (v1.0.0)
- Trigger: feasibility/planning stage when user data is missing.
- Goal: provide public data hints with source links.

## `agent_builder` (v1.0.0)
- Trigger: `/confirm` after approved analysis.
- Goal: implement prototype/change in project workspace.

## `agent_tester` (v1.0.0)
- Trigger: after builder writes code.
- Goal: technical checks (build/typecheck/run).

## `agent_revisor` (v1.0.0)
- Trigger: after tester pass.
- Goal: UI/flow review against original brief.

## `agent_estimator` (v1.0.0)
- Trigger: `/estimate`.
- Goal: structured production estimate with assumptions/risks.
