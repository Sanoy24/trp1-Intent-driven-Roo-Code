# Shared Brain — TRP1 Governed Workspace

_Append-only. Machine-managed brain for cross-session knowledge persistence._

## Architectural Decisions

- 2026-02-17: Implementing Intent-Driven Architecture to solve context management bottleneck.
- 2026-02-17: Using SHA-256 content hashing for spatial independence in the Agent Trace spec.

## Lessons Learned

- [SYSTEM_BOOT] Initializing the governance framework. Handshake protocol is NOW ACTIVE.
- [RULE] Protocol Enforcement: Your first action MUST be `select_active_intent(intent_id)`.

## Project Constitution

- All code generated must be accompanied by a semantic trace record.
- Destructive commands MUST be explicitly classification-checked by the Hook Engine.

## [DECISION] 2026-02-21T10:58:22.601Z

Intent **INT-003: Build Weather API** was completed and marked DONE.

**Acceptance Criteria Achieved:**

- GET /weather/:city returns temperature, humidity, and description
- GET /weather/coordinates/:lat/:lon returns weather by coordinates
- Unit tests cover the service layer
- API returns consistent JSON schema

**Scope covered:** src/\*_/_, _.ts, _.js, _.json, _.md

**Constraints honoured:** Use OpenWeatherMap API via HTTP only, no SDK; All endpoints must return JSON with a consistent schema; Implement proper error handling; Use TypeScript for type safety
