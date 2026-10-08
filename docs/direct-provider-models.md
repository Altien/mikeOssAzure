# Direct provider models

The curated catalog was checked against provider documentation on 2026-10-07.
It offers current general-purpose text/tool models, with smaller models for
automatic titles and task settings. It does not include image-generation,
audio, embedding, or restricted-access models.

| Provider | Chat and tabular selection | Automatic title model |
| --- | --- | --- |
| Anthropic | Claude Fable 5.1, Opus 5.5, Sonnet 5.5 | Claude Haiku 4.5 |
| Google | Gemini 3.8 Flash, Gemini 3.1 Pro (Preview) | Gemini 3.5 Flash-Lite |
| OpenAI | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna | GPT-6 Luna |
| Mistral AI | Mistral Large 4 (Preview), Medium 3.5, Small 4 | Mistral Small 4 |

Main chat still requires an explicit model selection. Internal Gemini fallbacks
use 3.8 Flash. A saved title-model override continues to take precedence.

## Provider switches

Configured provider cards show a switch for the current account. Turning a
provider off preserves shared credentials and saved model selections, but makes
its models unavailable to that user and blocks secondary Key Vault or
environment fallback. The Azure router and legacy Azure OpenAI aliases share
one preference. Turning it back on restores normal credential resolution.

Numbered migration 0108 adds a per-user preference map and an atomic,
service-role-only update function. Preference updates never create, replace or
delete shared credentials or encrypted legacy secret rows.

## Mistral setup

Create an API key in [Mistral Studio](https://console.mistral.ai/). In this
deployment provider credentials belong to the organisation: an administrator
stores the key once through `/install` (AI providers → Mistral AI API key), which
writes the Key Vault secret `mistral-api-key`. The backend reads that secret
first and falls back to `MISTRAL_API_KEY` only for local development. Users do
not save personal keys; Settings → API Keys shows whether the organisation
credential is configured, and a personal key write returns
`organisation_api_key_required`.

Dev divergence (sync-log: 2f30082a): upstream's
`20261007_01_add_mistral_user_api_key_provider.sql` only widens the
`user_api_keys` provider constraint for personal keys. Dev stores no personal
provider keys, so no numbered migration was added. Azure OpenAI deployments and
Kimi K3 remain first-class organisation providers alongside this catalog.

Mistral requests use the native `@ai-sdk/mistral` adapter at
`https://api.mistral.ai/v1`. Streaming, tool calls, tool results, and reasoning
blocks use the existing shared AI SDK loop. The available reasoning controls are
None and High. The API IDs are `mistral-large-4`, `mistral-medium-3-5`, and
`mistral-small-2603`. Large 4 is currently a public preview, labeled accordingly.

## Amazon Bedrock and Azure OpenAI setup

Provider credentials are shared by this installation and configured by an
administrator in Azure Key Vault. Environment variables are a fallback for
local development. Users see credential availability under Settings → API Keys
and choose router model IDs under its Routers section. Personal key changes
remain refused.

- Amazon Bedrock uses `aws-bearer-token-bedrock` (alias `bedrock-api-key`)
  and `bedrock-aws-region` (alias `aws-region`). The corresponding environment
  fallbacks are AWS_BEARER_TOKEN_BEDROCK and BEDROCK_AWS_REGION (or AWS_REGION).
- Azure Responses uses the existing Azure connection: `azure-openai-api-key`
  and `azure-openai-endpoint`; `azure-api-key` is also accepted. An endpoint
  may be a resource name or an https URL on an Azure AI hostname. Every vault
  alias is checked before environment fallback.

Keys and the region or endpoint supplied to a request stay together. The
model IDs are `bedrock/<model-or-inference-profile-id>` and
`azure/<deployment>`; an explicit router ID must be in the user's saved
selection. Bedrock uses bearer-authenticated Converse and Azure uses the v1
Responses API. Existing `aoai:<deployment>` models keep their Azure Chat
Completions protocol and encrypted compound settings.

Numbered migration 0106 adds companion settings and extends the legacy
provider constraint without replacing existing Azure payloads or identity
types.

## Google Vertex AI, Azure AI Foundry, xAI and custom endpoints

Four more providers are configured centrally in Key Vault. Companion values
are kept with the deployment key, like Bedrock and Azure OpenAI:

| Provider | Key | Saved with |
| --- | --- | --- |
| Google Vertex AI | The full contents of a service-account key file (JSON) | The Vertex AI location, for example `us-central1` or `global` |
| Azure AI Foundry | The Foundry resource's API key | The resource name (`contoso-foundry`) or its endpoint URL |
| xAI | An xAI API key | — |
| OpenAI-compatible endpoint | The endpoint's API key | Its base URL, for example `https://llm.example.com/v1` |

Use `google-vertex-credentials-json` with `google-vertex-location`,
`azure-foundry-api-key` with `azure-foundry-endpoint`, `xai-api-key`, and
`custom-api-key` with `custom-base-url`. Uppercase underscore equivalents are
local environment fallbacks. Existing `MIKE_MODEL_CONFIG_JSON` declarations
remain supported for shared endpoints, including approved private endpoints.
Every new cloud input checks Key Vault before its environment fallback.

Users add model selections once the administrator has configured a provider. The app-level IDs are
`vertex/<model-id>`, `azure-foundry/<deployment>`, `xai/<model>` and
`custom/<model>`, and a request can only use a model in the requesting user's
saved list.

- **Vertex AI:** the service account needs the Vertex AI User role, and the
  project is read from the key file's `project_id`. A model ID selects the
  protocol: `claude…` IDs (`claude-opus-5-5@20260101`) use Anthropic Messages,
  `publisher/model` IDs (`meta/llama-4-maverick-maas`) use the
  OpenAI-compatible partner-model endpoint, and anything else is sent to the
  Gemini API. Access tokens are minted from the key's email and private key
  only and cached per key; the file's `token_uri` is ignored, and neither
  ambient Google credentials nor a `GOOGLE_VERTEX_API_KEY` in the environment
  is ever used. Models are typed by ID.
- **Azure AI Foundry:** deployment names of non-OpenAI models. A deployment
  whose name contains `claude` is called over Anthropic Messages at
  `/anthropic/v1`; every other deployment is called over Chat Completions at
  `/openai/v1`, without reasoning controls. Rename-proofing is not possible
  with an API key, so keep `claude` in the name of Claude deployments. OpenAI
  deployments belong under Azure OpenAI, which uses the Responses API.
- **xAI:** the model list is read live from `https://api.x.ai/v1/models`, with
  image, video and voice models filtered out. Requests use `@ai-sdk/xai`.
- **OpenAI-compatible endpoint:** any service that implements
  `POST {base URL}/chat/completions`, such as a LiteLLM proxy, vLLM, Groq,
  Together, Fireworks or DeepSeek. The model list is read from
  `GET {base URL}/models` when the endpoint offers one; otherwise IDs are
  typed. Because the backend sends requests and the key to a configured
  URL, the URL must be public `https`, and every request goes through the
  same guarded fetch as custom MCP connectors: loopback, private, link-local
  and cloud-metadata addresses are refused, including when a public name
  resolves to one. Endpoints on a private network belong in
  `MIKE_MODEL_CONFIG_JSON`.

Before deploying, apply numbered migrations 0107 and 0108 for provider
constraints and account preferences. Dev retains text user identities and
application access control; Supabase RLS/schema.sql are not imported.

## Saved selections

Removed direct-provider IDs are normalized when read, including saved chat,
profile, and task selections. No historical chat records are rewritten.

| Previous selection | Replacement |
| --- | --- |
| Claude Fable 5 | Claude Fable 5.1 |
| Claude Opus 5, 4.8, 4.7 | Claude Opus 5.5 |
| Claude Sonnet 5, 4.6 | Claude Sonnet 5.5 |
| Gemini 3.7, 3.6, 3.5 Flash; 3 Flash Preview | Gemini 3.8 Flash |
| Gemini 3.1 Flash-Lite, including preview ID | Gemini 3.5 Flash-Lite |
| GPT-5.6 Sol | GPT-6 Astra |
| GPT-5.6 Terra, GPT-5.5, GPT-5.4 | GPT-6.1 Sol |
| GPT-5.6 Luna, GPT-5.4 Mini/Lite | GPT-6 Luna |

Replacement models may have different pricing and output behavior. Users can
change their selections in the model picker and task settings. GPT-6 Astra and
GPT-6.1 Sol require reasoning, so a saved None setting is normalized to Low.
Current Fable and Opus also require thinking. Sonnet's lowest setting uses the
SDK's `between_tools` behavior. Lightweight automatic titles use their provider's
small model with reasoning disabled.

OpenRouter and Vercel continue to use their live catalogs and users' saved
allowlists. OpenCode Go retains its protocol compatibility list. Ollama models
remain dynamically discovered. These IDs are not rewritten by the direct-model
mappings.

## Catalog maintenance

Keep `backend/src/lib/llm/models.ts`, the web `ModelToggle.tsx`, and the Word
add-in's `modelCatalog.ts` synchronized, including legacy mappings. Update
reasoning capabilities in the backend and shared `ModelToggleUI.tsx` together.

Sources:

- [Anthropic models](https://platform.claude.com/docs/en/models/overview)
- [Claude thinking compatibility](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [OpenAI models](https://developers.openai.com/api/docs/models)
- [GPT-6 migration](https://developers.openai.com/api/docs/guides/latest-model)
- [Mistral models](https://docs.mistral.ai/models)
- [Mistral Large 4](https://docs.mistral.ai/models/mistral-large-4-0)
- [Mistral Medium 3.5](https://docs.mistral.ai/models/mistral-medium-3-5-26-04)
- [Mistral Small 4](https://docs.mistral.ai/models/mistral-small-4-0-26-03)
- [Mistral AI SDK adapter](https://ai-sdk.dev/providers/ai-sdk-providers/mistral)
