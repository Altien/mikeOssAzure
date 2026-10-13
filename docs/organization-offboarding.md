# Organization offboarding

Removing a member, leaving an organization and deleting an account use the
same organization content rules. Account deletion applies them to every team
organization before deleting personal workspace data and the authentication
account. An organization never acquires someone's personal workspace.

| State after departure | Result |
| --- | --- |
| Another item owner remains | Keep the item and its existing owners. |
| Public or shared with remaining members, without another owner | Transfer to one selected member; default to a remaining organization owner. |
| Private and unshared, without another owner | Archive for 30 days, then permanently delete. |

The rules cover projects, workflows, standalone chats, tabular reviews and
uploaded library documents. Project and workflow contents follow their parent.
Library files referenced by retained conversations or reviews are retained too.
Recovering archived work also recovers its archived library dependencies when
those dependencies are still within their recovery period.

Only organization owners can list, reassign or permanently delete archived
work, under **Organization settings → Members → Departed**. That view lists one
row per departure (the person, when they left, and when their work is deleted),
which opens into the types of work and then the items, so an owner can hand
over or delete everything a person left, one type, or a selection. A departed
member whose account has since been deleted is listed as a former member,
without a name. Reassigning assigns an owner and removes the expiry date.
Archived content is excluded from ordinary access, including access by
organization owners; it must be reassigned first. Removal previews show counts for private work and never
expose its titles to administrators.

Admins can remove ordinary members and transfer their shared work. They cannot
manage the private archive or remove organization owners/admins. The last owner
must appoint another owner or explicitly delete the organization, even when the
organization is empty. No editor is automatically promoted to organization
owner.

## Joining during signup

After signing up and verifying their email, a user can view and accept pending
organization invitations on a separate third onboarding screen, after profile
and legal practice details. Each invitation shows
the organization, offered role and inviter. Accepting selects that organization
for the end of setup; it does not complete onboarding or remove the user's
personal workspace. Users can continue setup without accepting and decide later
in Settings → Organizations. Invitation details are never looked up from an
unverified email entered into the signup form.

## Transactions and operations

`remove_org_member` rechecks permissions under an organization lock. Its
membership-deletion trigger transfers or archives content and revokes the
departing member's ownership and grants in the same transaction.
`request_account_deletion` atomically offboards all team memberships, inserts
the account deletion job and sets `account_deletion_requested_at`. API
authentication refuses further access while deletion is pending. The worker
deletes personal data before the authentication account and can safely retry.

`org_departure_events` records transfers, archives, recoveries, deletions and
expiry in their database transactions. These organization records survive the
departing account's deletion and contain no copied email or private item title.

The worker maintenance sweep expires archives in batches of 100, beginning
30 seconds after worker startup and repeating on `STALE_SWEEP_INTERVAL_MS`.
Recovery stops at the expiry timestamp even if a sweep is delayed. Document
deletion uses the existing durable document-cleanup queue. Run a worker runtime
when the API uses `WORKERS_MODE=none`; otherwise scheduled expiry will not run.

Apply `20261013_05_org_departure_retention.sql` and
`20261013_06_org_departure_listing.sql` before deploying this backend.
Fresh installations already include it in `backend/schema.sql`. The migration
cannot recover private content deleted under the previous removal policy.

The PostgreSQL regression suite creates and drops its own disposable database:

```bash
MIKE_TEST_POSTGRES_CONTAINER=supabase_db_backend npm test --prefix backend -- \
  src/__tests__/integration/orgDepartureRetention.postgres.test.ts
```
