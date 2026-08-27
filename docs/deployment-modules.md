# Optional deployment modules

Mike's optional functionality is controlled at two levels:

1. The deployment operator decides which packaged modules are available.
2. Each user decides which available modules are enabled for their account.

The deployment allow-list is authoritative. A user preference cannot enable a
module that the deployment operator has disabled.

## Configuration

Set `MIKE_ENABLED_MODULES` in the backend environment. It accepts `all`,
`none`, or a comma-separated list of module keys. Omitting the variable is
equivalent to `all` for compatibility with installations created before the
module registry was added.

```dotenv
MIKE_ENABLED_MODULES=legalMonitors,playbooks,promptLibrary
```

Available keys:

| Key | Functionality |
| --- | --- |
| `promptLibrary` | Saved prompt library and prompt picker |
| `legalMonitors` | Generic scheduled monitoring and monitor presets |
| `playbooks` | Word playbook import, editing, and reviews |
| `ironclad` | Ironclad document search and import |
| `gmail` | Gmail OAuth, search, import, and assistant tools |
| `localModels` | Configured local OpenAI-compatible models |
| `committeeModels` | Multi-model committee orchestration |
| `patentConnector` | Managed USPTO Patent MCP connector preset |

Fintech and Trademark Monitoring are not independent modules. They are monitor
templates that appear only when Monitoring is available and their deployment
prerequisites are satisfied. Fintech requires its explicit preset setting;
Trademark requires a compatible configured connector. Neither creates a
monitor or seeded data on a clean installation.

Dark Mode is an appearance preference rather than a deployment module. Generic
user-created MCP connectors and upstream Mike functionality remain part of the
core application. The Word add-in is optional at packaging/deployment time: it
is absent unless the separate `word-addin` application is built and sideloaded
or published, so it does not need a backend feature gate.

## Profiles

An upstream-minimal deployment can start with:

```dotenv
MIKE_ENABLED_MODULES=none
MIKE_DATABASE_PROVIDER=supabase
MIKE_AUTH_PROVIDER=supabase
MIKE_STORAGE_PROVIDER=r2
```

A self-contained deployment can use all packaged modules with local services:

```dotenv
MIKE_ENABLED_MODULES=all
MIKE_DATABASE_PROVIDER=sqlite
MIKE_AUTH_PROVIDER=local
MIKE_STORAGE_PROVIDER=sqlite
```

When a module is unavailable, its API returns HTTP 404 with the
`module_unavailable` code, background work for that module does not start, and
the Features page shows its user toggle as locked.
