# Model Orchestration

Mike reads optional model orchestration settings from `MIKE_MODEL_CONFIG_JSON`
in the backend environment.

## Configure A Local OpenAI-Compatible Model

Run any local server that exposes the OpenAI chat-completions API, such as
Ollama, LM Studio, vLLM, or LocalAI.

Example with Ollama:

```bash
ollama serve
ollama pull llama3.1
```

Then configure the backend:

```bash
MIKE_MODEL_CONFIG_JSON='{
  "models": [
    {
      "id": "local-llama",
      "label": "Local Llama",
      "provider": "openai-compatible",
      "location": "local",
      "apiModel": "llama3.1",
      "baseUrl": "http://localhost:11434/v1"
    }
  ]
}'
```

`id` is the stable name shown inside Mike. `apiModel` is the model name sent to
the local OpenAI-compatible server. If `apiModel` is omitted, Mike sends `id`.

If your local server requires a bearer token, add either `apiKey` or
`apiKeyEnv`:

```bash
MIKE_MODEL_CONFIG_JSON='{
  "models": [
    {
      "id": "local-secure",
      "label": "Local Secure Model",
      "provider": "openai-compatible",
      "location": "local",
      "baseUrl": "http://localhost:8000/v1",
      "apiKeyEnv": "LOCAL_OPENAI_API_KEY"
    }
  ]
}'
LOCAL_OPENAI_API_KEY='your-local-server-token'
```

## Configure Cloud Models

Built-in Claude, Gemini, and OpenAI model IDs still work through their normal
provider keys:

```bash
ANTHROPIC_API_KEY='...'
GEMINI_API_KEY='...'
OPENAI_API_KEY='...'
```

## Select an OpenRouter Model

Add your key under **Account > API Keys > OpenRouter API Key**. Mike then
loads the OpenRouter catalog through the backend and adds an **OpenRouter**
group to the searchable model menus. The selected model is available for chat,
title generation, and tabular review preferences under **Account > Model
Preferences**.

OpenRouter model IDs are stored with an `openrouter/` prefix inside Mike (for
example, `openrouter/anthropic/claude-sonnet-4`) and are sent to OpenRouter
without that prefix. The API key remains server-side and is never returned to
the browser.

## Configure Kimi K3

Kimi Code's K3 models are available in the model dropdown under **Moonshot**.
Provide a key in **Account > API Keys > Moonshot (Kimi) API Key**, or set
`KIMI_API_KEY` in the backend environment for the whole instance:

```bash
KIMI_API_KEY='...'
```

Mike includes these built-in Kimi entries:

- `kimi-k3` → Kimi Code model ID `k3`, up to 1M context where your Kimi plan
  allows it.
- `kimi-k3-256k` → Kimi Code model ID `k3-256k`, the practical default for
  most coding and document-review work within 256k context.

Both use Kimi Code's OpenAI-compatible endpoint:

```text
https://api.kimi.com/coding/v1
```

Mike sends `reasoning_effort: "high"` by default for these built-in Kimi
entries. To change that, override the entries in `MIKE_MODEL_CONFIG_JSON`:

```bash
MIKE_MODEL_CONFIG_JSON='{
  "models": [
    {
      "id": "kimi-k3",
      "label": "Kimi K3 Max Reasoning",
      "provider": "openai-compatible",
      "location": "cloud",
      "apiModel": "k3",
      "baseUrl": "https://api.kimi.com/coding/v1",
      "apiKeyEnv": "KIMI_API_KEY",
      "apiKeyProvider": "kimi",
      "extraBody": {
        "reasoning_effort": "max"
      }
    }
  ]
}'
```

Use Kimi's model IDs (`k3`, `k3-256k`, `kimi-for-coding`,
`kimi-for-coding-highspeed`) as `apiModel` values. Do not use display names like
`Kimi K3`.

You can also add labeled cloud entries:

```bash
MIKE_MODEL_CONFIG_JSON='{
  "models": [
    {
      "id": "gpt-5.4",
      "label": "OpenAI Review Model",
      "provider": "openai",
      "location": "cloud"
    }
  ]
}'
```

## Configure A Committee

A committee is selected like a model. Each member produces an independent
answer, then the chair model synthesizes the final response.
Members run sequentially in the order listed. This avoids overloading a single
local model server when several agents share the same OpenAI-compatible runtime.

```bash
MIKE_MODEL_CONFIG_JSON='{
  "models": [
    {
      "id": "local-llama",
      "label": "Local Llama",
      "provider": "openai-compatible",
      "location": "local",
      "apiModel": "llama3.1",
      "baseUrl": "http://localhost:11434/v1"
    }
  ],
  "committees": [
    {
      "id": "legal-committee",
      "label": "Legal Committee",
      "members": [
        "local-llama",
        "gpt-5.4-lite",
        "claude-haiku-4-5"
      ],
      "chair": "gpt-5.4-lite"
    }
  ]
}'
```

Notes:

- `members` can include built-in model IDs and configured model IDs.
- `members` can also be agent objects with `model`, `label`, and
  `systemPrompt`.
- `members` run in list order. Put faster or narrower local agents first if you
  want their calls completed before broader review agents.
- `chair` must be a single model ID. It should be reliable and concise.
- Committee mode is currently for non-tool completions and chat surfaces without
  document/case-law tool calls. Use an individual model when tool use is needed.
- Local models are treated as already available; cloud members still require
  their provider API keys.

## Local OpenAI-Enabled Agents

For local OpenAI-compatible agents, run one or more local servers that expose
`/v1/chat/completions`. The backend can point multiple logical agents at the
same local model while giving each agent a different role prompt.

Example using a single Ollama model as three legal-review agents:

```bash
ollama serve
ollama pull llama3.1
```

```bash
MIKE_MODEL_CONFIG_JSON='{
  "models": [
    {
      "id": "local-llama",
      "label": "Local Llama 3.1",
      "provider": "openai-compatible",
      "location": "local",
      "apiModel": "llama3.1",
      "baseUrl": "http://localhost:11434/v1"
    }
  ],
  "committees": [
    {
      "id": "local-legal-agents",
      "label": "Local Legal Agents",
      "members": [
        {
          "id": "issue-spotter",
          "label": "Issue Spotter",
          "model": "local-llama",
          "systemPrompt": "Act as a careful legal issue spotter. Identify ambiguities, missing facts, and legal-risk questions."
        },
        {
          "id": "contract-reviewer",
          "label": "Contract Reviewer",
          "model": "local-llama",
          "systemPrompt": "Act as a contract reviewer. Focus on obligations, deadlines, defined terms, remedies, and drafting inconsistencies."
        },
        {
          "id": "skeptical-counsel",
          "label": "Skeptical Counsel",
          "model": "local-llama",
          "systemPrompt": "Act as skeptical counsel. Challenge unsupported assumptions and flag where the answer needs authority or document support."
        }
      ],
      "chair": "gpt-5.4-lite"
    }
  ]
}'
```

In this pattern:

- each agent calls the same local OpenAI-compatible model;
- each agent receives the user request plus its own `systemPrompt`;
- agents run one after another in the order listed;
- the chair receives all member outputs and writes the final answer;
- the chair can be local too, for a fully local committee:

```json
{
  "id": "fully-local-legal-agents",
  "label": "Fully Local Legal Agents",
  "members": [
    {
      "id": "issue-spotter",
      "model": "local-llama",
      "systemPrompt": "Find legal and factual issues."
    },
    {
      "id": "drafter",
      "model": "local-llama",
      "systemPrompt": "Suggest concise drafting improvements."
    }
  ],
  "chair": "local-llama"
}
```

If you run different local models on different ports, create one model entry per
server:

```json
{
  "models": [
    {
      "id": "local-fast",
      "provider": "openai-compatible",
      "location": "local",
      "apiModel": "llama3.1",
      "baseUrl": "http://localhost:11434/v1"
    },
    {
      "id": "local-careful",
      "provider": "openai-compatible",
      "location": "local",
      "apiModel": "qwen2.5:14b",
      "baseUrl": "http://localhost:8000/v1",
      "apiKeyEnv": "LOCAL_CAREFUL_API_KEY"
    }
  ]
}
```

## SQLite Data Settings

The backend stores application data and document bytes locally:

```bash
SQLITE_DB_PATH=./data/mike.sqlite
SQLITE_STORAGE_PATH=./data/mike-files.sqlite
```

Keep both files backed up together. The first stores application rows and local
auth sessions; the second stores uploaded/generated document bytes.
