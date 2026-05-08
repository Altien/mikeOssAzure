-- Adds per-user credential storage for two more LLM providers:
-- OpenAI (single key) and Azure OpenAI (endpoint + key + api version +
-- deployment name).
--
-- Why: alongside the existing Anthropic and Gemini keys, the app needs to
-- support customers who already have an OpenAI account or — more
-- importantly for the Azure marketplace listing — an Azure OpenAI
-- deployment in their own subscription.
--
-- Azure OpenAI is shaped differently from a single-key provider: the SDK
-- needs the resource endpoint URL, the API version pin, and the
-- deployment name (which maps to a model on the customer's resource).
-- All four columns are nullable; "configured" means endpoint+key+
-- deployment are all present (api_version falls back to a sane default
-- in the adapter).
--
-- Auto-discovery of which deployments a configured AOAI endpoint exposes
-- is the next ticket — this migration only stores what the user types.

alter table public.user_profiles
  add column if not exists openai_api_key text,
  add column if not exists azure_openai_endpoint text,
  add column if not exists azure_openai_api_key text,
  add column if not exists azure_openai_api_version text,
  add column if not exists azure_openai_deployment text;
