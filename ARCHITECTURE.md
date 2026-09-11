# InfinityCore Architecture

**Style:** Modular monolith, service-oriented, microservice-ready. Not a
physical microservices deployment — one React SPA + Supabase, with clean
internal domain boundaries so features can change independently.

```
                    INFINITYCORE
                         │
        ┌────────────────┼────────────────┐
        │                │                │
       HR           PERFORMANCE       BANKONE
   (employees,          │            (imports,
    onboarding,     appraisals,      transactions)
    leave,           targets,
    attendance)        NPRA
        │                │
        └────────────────┼────────────────┐
                         │                │
                  RECONCILIATION         SARA
                  (exceptions,      (orchestration —
                   reversals)     calls other domains,
                                   never bypasses them)
```

## Domain layer: `src/domains/`

Each subfolder is a thin, additive facade (`index.js`) that re-exports the
existing service(s) that already own that domain's business logic. **No
existing file was moved, renamed, or rewritten** — this is a safe first
step (rule: adapter over rewrite) that gives every domain one official
import path going forward, without touching anything that currently works.

| Domain | `src/domains/<x>` | Backing service(s) in `src/services/` |
|---|---|---|
| Auth | `auth` | `useAuth` hook, `PERMISSIONS`, `roles` constants |
| Employees | `employees` | `employeeService` — master record, Employee 360 source |
| Onboarding | `onboarding` | `onboardingService`, `onboardingCorrectionService`, `guarantorVerificationService` |
| Leave | `leave` | `leaveApprovalsService`, `leaveBalanceService`, `computeLeaveInsights`, `leaveRulesService` |
| Attendance | `attendance` | `attendanceService`, `attendanceEngineService`, `geofenceService` |
| Payroll | `payroll` | `payrollService` |
| Recruitment | `recruitment` | `hrService`, `interviewService`, `hrQueryService` |
| Performance | `performance` | `performanceService`, `appraisalService`, `targetService` |
| BankOne | `bankone` | `bankoneImportService`, `importService` |
| Reconciliation | `reconciliation` | `reconciliationService` — reads BankOne data, never mutates it |
| Reports | `reports` | `kpiService` |
| Notifications | `notifications` | `notificationService` |
| SARA | `sara` | `agentService`, `saraAlerts`, `saraCommandParser`, `saraIntelligence`, `saraNlu`, `saraPreReview`, `saraSettings`, `saraStats`, `saraVoice` |
| Platform (shared) | `platform` | `documentService`, `taskService`, `workManagementService`, `workTaskService`, `platformSettingsService`, `supportCaseService`, `userApprovalService` — cross-cutting, used by multiple domains |

`customers`, `loans`, and `audit` are reserved but currently empty — see
**Architectural debt** below.

## Ownership rules

- **BankOne owns raw imported transactions.** Reconciliation consumes them;
  it never edits BankOne's import records.
- **Payroll, Leave, Attendance, Recruitment are independent.** Changing one
  must not require editing another's service file.
- **SARA is orchestration only.** It calls into domain services (leave,
  payroll, onboarding, etc.) and must never duplicate their business logic
  or bypass their authorization checks.
- **Employee 360 (`EmployeeProfile.jsx`) is a presentation layer.** It
  should read from `employees`, `leave`, `payroll`, `attendance`,
  `performance`, `onboarding` domains rather than owning data duplicated
  from them.

## Data access pattern

```
Page/Component → Domain Service (src/services/*, re-exported via
                  src/domains/<domain>) → Supabase
```

Sensitive actions (role changes, approvals, payroll changes, onboarding
approval, guarantor approval, reconciliation closure, employee status
changes) stay authorized server-side via Supabase RLS — frontend
permission checks are UX only, not the security boundary. Nothing in this
pass touched RLS policies, table schemas, or service-role keys.

## Fault isolation

Existing `src/components/PageStates.jsx` (`LoadingState`, `EmptyState`,
`ErrorState`) is the standard per-page error boundary pattern already in
use across services (e.g. `AttendanceManagement.jsx`, `OnboardingLinks.jsx`).
One domain's Supabase error surfaces as that page's `ErrorState`, not a
blank app screen — this was already true before this pass and is
preserved.

## Architectural debt (not fixed in this pass — flagged, not silently left)

These pages/components query `supabaseClient` directly instead of going
through a domain service. Left alone deliberately: fixing 19 files' worth
of call sites is a real refactor with real regression risk, not a safe
one-pass change.

**Pages (10):** `Assessments.jsx`, `EmployeeProfile.jsx`, `Users.jsx`,
`CustomerDashboard.jsx`, `hrShared.jsx`, `Reports.jsx`, `HRJobs.jsx`,
`LeaveBalances.jsx`, `OnboardingReview.jsx`, `HRDashboard.jsx`

**Components (9):** `attendance/SaraBriefing.jsx`, `AddEmployeeModal.jsx`,
`review/OnboardingReviewCenter.jsx`, `EmployeeHRActions.jsx`,
`Customer360Modal.jsx`, `Layout.jsx`, `EmployeeCompletionModal.jsx`,
`OnboardingFlow.jsx`, `EmployeeModals.jsx`

**No domain service yet exists for:**
- **Customers** — `CustomerDashboard.jsx` / `Customer360Modal.jsx` query
  Supabase directly. No `customerService`.
- **Loans** — `Loans.jsx` / `Repayments.jsx` likely query Supabase
  directly; only `src/lib/loanScoring.js` (a pure scoring function, not a
  data-access service) exists today.
- **Audit** — `AuditLogs.jsx` has no dedicated `auditService`.

## Rule for adding future features

1. New business logic goes in an existing `src/services/*.js` file for its
   domain, or a new one if the domain doesn't have one yet.
2. Export it from the matching `src/domains/<domain>/index.js`.
3. New pages/components import from `src/domains/<domain>`, not
   `supabaseClient` directly and not another domain's service file.
4. If a change to domain A requires editing domain B's service file to
   work, stop — that's the coupling this structure exists to prevent.

## Future microservice extraction

If a domain ever needs to become a real separate service (most likely
candidates: BankOne imports, given file-processing load, or SARA, given
AI/LLM cost isolation), the `src/domains/<domain>` boundary is the seam:
the facade's public shape becomes the service's API contract, and the
Supabase calls behind it move behind an HTTP boundary instead. No domain
currently needs this — noted for when it does.
