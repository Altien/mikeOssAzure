# scripts/install

This directory is intentionally empty in the OSS fork.

The `/install` configurator route in `backend/src/routes/install.ts`
serves operator scripts from `/app/scripts/install` at request time
(see `GET /install/scripts/:name`). In Altien's downstream marketplace
package, this directory is populated with PowerShell scripts that
automate Entra app registration, Azure OpenAI provisioning, and
role assignments.

In the OSS fork those scripts are not bundled. The route gracefully
degrades when this directory is empty or missing: the install
configurator's "Download script" buttons disappear and the rest of
the configurator continues to work.

This file exists so the `COPY scripts/install ./scripts/install`
line in the runtime stage of the Dockerfile succeeds during a clean
build of the OSS fork. Removing the file or directory will break
`docker build` / `az acr build` of the OSS fork until the Dockerfile
is patched to drop the COPY.

If you operate a downstream of this fork that ships its own scripts,
drop them alongside this README before building the image. The
runtime route accepts files matching `^[a-z][a-z0-9-]+\.ps1$`.
