# scripts/install

This directory is for operator-side PowerShell scripts that the
`/install` configurator route serves at request time via
`GET /install/scripts/:name` (see `backend/src/routes/install.ts`).

The directory is empty by default in this fork. The route gracefully
degrades when the directory is absent or empty — the install
configurator's "Download script" buttons disappear and the rest of
the configurator continues to work.

## What goes here

PowerShell `.ps1` files with names matching `^[a-z][a-z0-9-]+\.ps1$`.
Operators run these on their own workstation (with their own
`az login`) to do work the Container App's Managed Identity cannot do
— typical examples: Entra app registration, Azure OpenAI provisioning,
role assignments to the deployer.

If you operate a downstream that ships its own scripts, drop them
here before building the image. The runtime route streams them as
`text/plain` for download.

This file exists so the `COPY scripts/install ./scripts/install`
line in the runtime stage of the Dockerfile succeeds during a clean
build. Removing the file or directory will break `docker build`
until the Dockerfile is patched to drop the COPY.
