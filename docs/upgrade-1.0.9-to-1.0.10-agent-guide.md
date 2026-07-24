# Mike – Open Source Legal AI: upgrade 1.0.9 → 1.0.10 (agent guide)

Audience: an AI agent (Claude Code, Copilot CLI, etc.) or engineer driving
the Azure CLI in the **customer's own tenancy**. The Mike marketplace offer
is a solution template — all resources below belong to the customer, and
this upgrade touches nothing outside their resource group.

What 1.0.10 fixes/adds (relevant to this procedure): document Download
previously failed on 1.0.9 (in Entra-mode installs the backend container
crashed with exit code 1 on the first Download click; ingress returned
Envoy 503s while it restarted). 1.0.10 fixes the download flow end to end,
self-provisions its signing secret, and adds upstream features (MCP
connectors, case-law research, document versioning — synced with upstream
Mike as of 2026-06-17).

The upgrade is: **run DB migrations with the new image, then swap the
backend image, then verify.** No ARM/template redeploy. Roughly 10 minutes.

---

## 0. Preconditions and discovery

Requirements: Azure CLI ≥ 2.60 with the `containerapp` extension, logged in
to the customer's tenant, subscription set to the one holding the install.
The identity used needs Contributor (or equivalent) on the resource group.

Discover the install (skip any step where the customer already gave you
the values):

```bash
# Find the resource group: it contains a Container App named 'backend'
az containerapp list --query "[?name=='backend'].{rg:resourceGroup, image:properties.template.containers[0].image, fqdn:properties.configuration.ingress.fqdn}" -o table
```

Record:
- `RG`     — the resource group name
- `FQDN`   — the backend's ingress FQDN (the app URL)
- current image — expect `acrmikeoss.azurecr.io/backend:1.0.9`

Sanity checks before proceeding:

```bash
# The migration job must exist (it does in every 1.0.9 install)
az containerapp job show -n db-migrate -g $RG --query name -o tsv

# The app must currently be healthy
curl -fsS https://$FQDN/config >/dev/null && echo "backend reachable"
```

If the current image tag is not `1.0.9`, stop and report — this guide is
written and tested for 1.0.9 → 1.0.10 exactly.

The new image is public (anonymous pull): `acrmikeoss.azurecr.io/backend:1.0.10`.
No registry credentials are needed anywhere in this procedure.

---

## 1. Run database migrations (BEFORE touching the backend)

1.0.10 ships six additive migrations (`0010`–`0015`: MCP connector tables
and list-overview SQL functions). They are backward-compatible — the
running 1.0.9 backend is unaffected by them — but 1.0.10 requires them on
its very first page load. **Always migrate first.**

```bash
# Point the migration job at the new image
az containerapp job update -n db-migrate -g $RG \
  --image acrmikeoss.azurecr.io/backend:1.0.10

# Start it
az containerapp job start -n db-migrate -g $RG

# Poll until the execution succeeds (typically < 60s)
az containerapp job execution list -n db-migrate -g $RG \
  --query "[0].{name:name, status:properties.status}" -o table
```

Wait for `Status: Succeeded`. If `Failed`, fetch the logs and stop — do
NOT proceed to step 2 with failed migrations:

```bash
az containerapp job logs show -n db-migrate -g $RG --container migrate
```

(The job's container is named `migrate`. Common failure causes: transient
Postgres connectivity — rerun once; anything else, report the log output.)

---

## 2. Swap the backend image

```bash
az containerapp update -n backend -g $RG \
  --image acrmikeoss.azurecr.io/backend:1.0.10
```

Container Apps performs a zero-downtime revision replacement: the new
revision must reach Running before traffic shifts. Confirm:

```bash
az containerapp revision list -n backend -g $RG \
  --query "[?properties.active].{rev:name, state:properties.runningState, traffic:properties.trafficWeight}" -o table
```

Expect one active revision at 100% traffic, running the new image.

---

## 3. Verify

**3a. Boot log — the self-seed line.** On its first boot, 1.0.10 detects
that the download signing secret is missing and provisions it into the
install's Key Vault itself:

```bash
az containerapp logs show -n backend -g $RG --tail 100 | grep -i "download-signing-secret\|running on port"
```

Expect `download-signing-secret: self-seeded in Key Vault` followed by
`Mike backend running on port 8080`. (If the replica has restarted since
the first boot, the self-seed line only appears in that first boot's logs —
in that case verify via 3b instead; a quiet boot is the already-seeded
path, not a failure.)

**3b. The secret exists in Key Vault** (name: `kv-mike-<env>`, in the same
resource group). Requires data-plane read on the vault; skip if the
identity doesn't have it — 3a/3c cover the same ground:

```bash
az keyvault secret show --vault-name <kv-name> --name download-signing-secret \
  --query attributes.created -o tsv
```

**3c. The API answers.**

```bash
curl -fsS https://$FQDN/config >/dev/null && echo OK
```

**3d. Human step — the actual fix.** An authenticated browser session is
required, so hand this to the operator: sign in at the app URL,
**hard-refresh (Ctrl+F5)** to drop the cached old frontend, open
Projects → any document → "…" → **Download**. A real PDF/DOCX must arrive
and open. On 1.0.9 this click crashed the backend; on 1.0.10 it downloads.

---

## 4. Known post-upgrade behaviours (tell the operator)

- **Old download links in chat history stop working.** Links minted before
  the upgrade were signed differently (or were broken); files are intact —
  re-download from the document menu. New links persist correctly.
- **MCP connectors (new in 1.0.10) need one extra secret on upgraded
  installs.** Fresh 1.0.10 installs get it from the template; image-only
  upgrades don't. If the customer wants MCP connectors, create a Key Vault
  secret named `mcp-connectors-encryption-key` (32+ random characters,
  e.g. `openssl rand -base64 32`) in the install's vault, then restart the
  backend revision. Until then, connector creation shows a clear error;
  everything else works. NOTE: keep this value stable forever — changing
  it makes already-stored connector credentials undecryptable.
- The `db-migrate` job and backend now both run `backend:1.0.10`; keep
  them in lockstep on future upgrades (always job first).

---

## 5. Rollback (if step 3 fails badly)

```bash
az containerapp update -n backend -g $RG \
  --image acrmikeoss.azurecr.io/backend:1.0.9
```

The migrations are additive and can stay — 1.0.9 ignores the new tables
and functions. Note that rolling back returns the customer to the known
1.0.9 download behaviour (broken), so treat rollback as a stopgap and
report what failed.
