# Credit policy and the 018 entitlement contract

Credits are an operator-defined unit. This repository supplies no provider
prices, exchange rate or production credit amounts. The operator publishes
an immutable model-price version, then the control plane assigns it to each
platform-paid tenant. Pooled platform calls fail closed if the budget or
model price is missing. Single-tenant mode keeps its existing unlimited path
without a credit database call. BYO calls skip credits in either mode and
retain token/request rate limits and the usage ledger.

## Publishing prices

Use `scripts/multi-tenant/publish-credit-prices.mjs` with a local JSON file
containing `version` and a nonempty `prices` array. Each entry needs:

| Field | Required value |
| --- | --- |
| `provider` | The backend provider ID, such as `openai`, `claude`, `azureOpenai` or `openai-compatible`. |
| `model` | The exact application model ID, including `openrouter/`, `vercel/`, `opencode-go/` or `aoai:` prefixes where applicable. |
| `input_per_million` | Nonnegative finite decimal **string**, credits per million uncached input tokens. |
| `output_per_million` | Nonnegative finite decimal string, credits per million output tokens. |
| `cache_read_per_million` | Nonnegative finite decimal string, credits per million cache-read input tokens. |
| `cache_write_per_million` | Nonnegative finite decimal string, credits per million cache-write input tokens. |
| `max_output_tokens` | Positive integer policy ceiling for each provider step. Set this deliberately for the model and plan. |

Rates are strings to preserve decimal precision. Neither the script nor the
backend calculates credit amounts in JavaScript. All price multiplication,
reservation comparisons and reconciliation use PostgreSQL `numeric`.

1. Choose the credit unit, model rates and output ceilings using the
   organisation's approved commercial policy. Save them in a local JSON file;
   no production values belong in a committed example.
2. Set `DATABASE_URL` through the operator's existing secure environment to
   a connection authorised to execute `public.publish_credit_prices(text,jsonb)`.
   The migration grants this only to `service_role`; 018 may expose a separate
   pricing operator role. Ordinary tenant/control-plane callers need no table
   write grant on `app.credit_prices`.
3. Run from the repository root:

   ```text
   node scripts/multi-tenant/publish-credit-prices.mjs <local-price-policy.json>
   ```

4. Assign the returned version through `cp_set_entitlements` after 018, using
   the budget contract below. Publish all models the tenant may use.

The publisher calls one SQL function, atomically inserts the full version,
and rejects version reuse, duplicates, negative/non-finite values and missing
ceilings. Existing versions cannot be updated or deleted. To change prices,
publish a new version and select it for future calls. Active calls retain
their original price version, including later tool steps.

## Entitlements consumed by 018

`cp_set_entitlements(tenant_id, jsonb)` must recognise an optional `budget`
object with these fields, mapping it to the existing `tenant_budgets` row:

| JSON field | SQL column | Contract |
| --- | --- | --- |
| `monthlyCredits` | `monthly_credits` | Required nonnegative finite decimal string. Zero refuses positive-cost calls. |
| `perUserCredits` | `per_user_credits` | Optional nonnegative finite decimal string, or null for no individual cap. |
| `softThreshold` | `soft_threshold` | Optional finite decimal string between zero and one, or null for no warning. |
| `priceVersion` | `price_version` | Required published price version. Every permitted provider/model needs a row. |

These fields describe policy; updating them must **never reset usage or
outstanding holds**. Absence/null means no budget policy and denies pooled
platform calls. BYO mode continues without spending platform credits. The
other 014 entitlement fields and secret-reference contract remain unchanged.
018 must cast and validate decimal strings in SQL and keep ordinary tenant
requests read-only on policy, counters and reservations.

`tenant_credit_periods` records tenant aggregate usage (`subject=''`) and
per-user usage (`subject=user ID`). Per-user caps apply to authenticated
requests and durable extraction/memory actors; truly system-owned work has
no user subject and still consumes the tenant budget. `used_credits` plus
`reserved_credits` is the admission balance. Existing holds use their
original month's counters; future steps honour the current allowance, while
their rate/version remains the one selected at admission.

## Admission, settlement and reporting

The backend reserves a conservative text prompt bound and enforced output
ceiling before the provider request. Each tool-loop step reserves again
using its actual accumulated messages and tool schemas. Cache classification
is unknown until usage arrives, so the reservation uses the highest input
class rate. Opaque SDK retries are disabled for budgeted calls; the explicit
reasoning-parameter retry makes another reserved step. These rules apply to
every stream/completion choke point, including tabular and memory work.

Settlement is one SQL transaction: lock the durable reservation, insert its
ledger event, debit actual credits and release the unused hold. Repeated
settlement does nothing; a settled reservation cannot admit another call.
SDK `inputTokens` is total input including cached tokens. Settlement charges
`max(0, input - cacheRead - cacheWrite)` at the uncached rate and each cache
class at its own rate, without double counting. Output has its separate rate.

Failed/aborted steps keep reported usage. If final usage is absent, the
ledger and credit settlement use the same conservative in-flight prompt
estimate and observed output estimate (bounded by that step's output cap).
Reported completed steps replace their estimates. Cancelling a request
before its final usage arrives cannot refund its whole prompt. Calls that
fail before entering a provider step settle zero and release their hold.

The reservation's UTC month and price version never change. Budgeted ledger
`created_at` is admission time, `credit_period` is the original UTC month,
and `completed_at` is settlement time. Thus existing daily token rollups group
budgeted calls by admission day; credit reports should sum ledger `credits`
by `credit_period`. Long calls crossing month-end debit their original month.
The budget row can select a new price version without repricing active work.

An interrupted process or failed settlement leaves the durable hold in place;
there is no automatic timeout refund of potentially billed usage. Investigate
`tenant_credit_reservations` with `settled_at is null` and reconcile through
the settlement function in the original tenant/actor context once usage is
known. The operator must not clear counters to make an alert disappear.
If a provider reports usage beyond its reserved bounds, settlement records
the reported cost exactly, flags the underestimate and blocks further calls
when the balance is exhausted; it never clips the billing record.

Metrics count `tenant.credit_budget.soft_warning`,
`tenant.credit_budget.admission_failed`,
`tenant.credit_budget.settlement_failed`, and
`tenant.credit_budget.reservation_underestimated`. A soft warning includes
outstanding holds and does not reject the call. `tenant.rate_limit_unavailable`
counts every rate-store failure while its log remains throttled; existing
rate-limit fail-open behaviour is retained. Budget failures fail closed and
use intentional organisation-budget messages, separate from provider errors.
