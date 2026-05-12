# Architectural Decision Log

> **Immutable. Append-only.** Every decision is permanent and numbered sequentially.
> To revise a decision, add a new ADR that explicitly supersedes the original by number.
> Never edit or delete entries — the integrity of this log depends on it.

_Generated: 2026-05-09 · Total decisions: 9_

---
## ADR-001 — What database should reasoning-layer use?

| | |
|---|---|
| **Date** | 2026-05-09 |

**Decision:**  
AWS RDS PostgreSQL on tokenoptimizer.cyrc84ocax4v.us-east-1.rds.amazonaws.com — same instance as tokenscope, new reasoning_layer database.

**Rationale:**  
Avoids running a local Docker Postgres, shares infra with tokenscope.

---

## ADR-002 — What billing models must be supported at launch — one-time charges, recurring subscriptions, usage-based metering, or a combination — and is the data model expected to accommodate all of them from day one?

| | |
|---|---|
| **Date** | 2026-05-09 |
| **Repo** | `/Users/manishkumar/Documents` |
| **Decided by** | <@U0B2TFPCRBN> |
| **Files** | /Users/manishkumar/Documents/reasoning-layer/.env |

**Decision:**  
lets use stripe for the billing backend.

**Rationale:**  
Its most popular

---

## ADR-003 — Which payment processors or gateways (e.g. Stripe, Braintree, Adyen) must be integrated at launch, and is the architecture expected to support multiple processors simultaneously or switch between them?

| | |
|---|---|
| **Date** | 2026-05-09 |
| **Repo** | `/Users/manishkumar/Documents` |
| **Decided by** | <@U0B2TFPCRBN> |
| **Files** | /Users/manishkumar/Documents/reasoning-layer/.env |

**Decision:**  
Stripe

---

## ADR-004 — What is the required audit trail depth — must every invoice state change, payment event, and refund be immutably logged with actor identity and timestamp for regulatory or dispute purposes?

| | |
|---|---|
| **Date** | 2026-05-09 |
| **Repo** | `/Users/manishkumar/Documents` |
| **Decided by** | <@U0B2TFPCRBN> |
| **Files** | /Users/manishkumar/Documents/reasoning-layer/.env |

**Decision:**  
invoide and payment event is good enough for MVP

---

## ADR-005 — Does the platform need to support anti-cheating or proctoring measures (e.g., tab-switch detection, webcam monitoring, randomized question ordering), and if so, are these enforced client-side or via a third-party proctoring service?

| | |
|---|---|
| **Date** | 2026-05-09 |
| **Repo** | `/Users/manishkumar/Documents/reasoning-layer` |

**Decision:**  
No anti-cheating or proctoring measures needed

**Rationale:**  
Not a requirement for this platform

---

## ADR-006 — Who owns and authors the test content — are questions stored in a central question bank managed by the platform, uploaded by individual teachers, or sourced from a licensed third-party question provider — and does this affect intellectual property or licensing obligations?

| | |
|---|---|
| **Date** | 2026-05-09 |
| **Repo** | `/Users/manishkumar/Documents/reasoning-layer` |

**Decision:**  
Platform owner authors and owns all test content

**Rationale:**  
Central question bank managed by the platform owner, no third-party licensing involved

---

## ADR-007 — Must the platform comply with India's DPDP Act 2023 for handling minors' personal data, and are there specific board-mandated requirements (CBSE/ICSE/State boards) that govern how test content, scores, and student records must be stored, retained, or deleted?

| | |
|---|---|
| **Date** | 2026-05-09 |
| **Repo** | `/Users/manishkumar/Documents/reasoning-layer` |
| **Decided by** | <@U0B2TFPCRBN> |

**Decision:**  
Yes it should

---

## ADR-008 — What is the expected concurrent user load during peak exam windows — for example, can thousands of students from the same institution start the same test simultaneously — and is there a defined SLA for response latency under that peak load?

| | |
|---|---|
| **Date** | 2026-05-09 |
| **Repo** | `/Users/manishkumar/Documents/reasoning-layer` |
| **Decided by** | <@U0B2TFPCRBN> |

**Decision:**  
100

---

## ADR-009 — Will this platform be deployed under a specific school/institution's infrastructure (single-tenant) or serve multiple schools and coaching institutes simultaneously (multi-tenant SaaS), and does each tenant require data isolation at the database level?

| | |
|---|---|
| **Date** | 2026-05-09 |
| **Repo** | `/Users/manishkumar/Documents/reasoning-layer` |
| **Decided by** | <@U0B2TFPCRBN> |

**Decision:**  
its generic and not tied to a institute.

---
