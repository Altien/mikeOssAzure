# Playbooks

Mike playbooks convert a human-authored Word negotiation guide into structured, versioned rules that can review contracts in the web app or Word add-in.

## Data model

A playbook contains global guidance and ordered topics. Each topic contains rules with:

- a concept to identify at clause or agreement scope;
- a required/optional setting;
- standard, fallback, and unacceptable positions;
- illustrative, preferred, verbatim, accepted, or unacceptable sample clauses;
- conditions, reviewer guidance, and escalation actions; and
- source references to the imported Word paragraph or table cell.

Imported content is always a draft. Publishing creates an immutable numbered version. Reviews use the last published version, so later draft edits do not change an in-progress or historical review.

## Importing a Word playbook

1. Open **Playbooks** in Mike and select **Import Word**.
2. Select a `.docx` playbook and a compilation model. Only models with usable credentials or a configured local endpoint are offered; Mike selects an available model by default.
3. Review the extracted topics, concepts, positions, sample clauses, and source references.
4. Save corrections and select **Publish**.

The importer reads Word headings, paragraphs, and tables before asking the model to compile the material. OpenRouter compilation requests use JSON output mode and response healing. For every provider, Mike automatically recompiles once when the first response is not valid JSON, fails schema validation, or cannot be tied back to the Word source. It retains the original `.docx` in SQLite file storage only after compilation succeeds. Every imported rule must resolve to at least one real source reference or the import fails rather than creating an unauditable rule.

Each model attempt has five minutes by default. Set `PLAYBOOK_COMPILATION_TIMEOUT_MS` to override that limit, or `LLM_REQUEST_TIMEOUT_MS` to set the shared OpenAI-compatible request limit. A playbook-specific value takes precedence.

Each import creates an audit record with its current processing stage. Failed imports retain the stage and error without retaining the source document, making credential, Word extraction, model compilation, and output-validation failures distinguishable.

In the Word add-in, open the source playbook, choose **Playbooks**, and select **Create playbook from this document**. Detailed editing remains available in the web app.

## Using a playbook in Assistant

1. Open Assistant and select **Playbook** beside the prompt controls.
2. Choose a published playbook. Draft-only playbooks are shown but cannot be selected.
3. Enter the request and attach the contract or other relevant documents.
4. Submit the prompt. The selected playbook applies to that turn and is then cleared.

Assistant loads the immutable published version on the backend after verifying ownership. The published playbook name and version appear on the submitted user message and remain visible in chat history. Later draft edits do not change the policy that governed the completed turn.

## Model selection

The searchable model menus for both compilation and contract review use the
same catalog as chat. They include built-in cloud models, discovered Ollama
models, OpenRouter models when an OpenRouter key is configured, and every
model or committee in `MIKE_MODEL_CONFIG_JSON`. A local OpenAI-compatible
model works without a provider API key when its configured endpoint does not
require one.

Example local model and sequential committee:

```json
{
  "models": [
    {
      "id": "local-reviewer",
      "label": "Local Reviewer",
      "provider": "openai-compatible",
      "location": "local",
      "apiModel": "your-local-model",
      "baseUrl": "http://127.0.0.1:8000/v1"
    }
  ],
  "committees": [
    {
      "id": "playbook-committee",
      "label": "Playbook Committee",
      "members": ["local-reviewer", "local-reviewer"],
      "chair": "local-reviewer",
      "strategy": "synthesize"
    }
  ]
}
```

Committee members and the chair run through Mike's sequential committee implementation. The same configured model can be selected independently for playbook compilation and contract review.

## Contract review

Publish the playbook, select **Review document**, choose strict or permissive posture, and supply a `.docx` or `.txt` contract. Strict mode flags fallback matches for review; permissive mode may accept them but still explains the applied fallback.

Review findings include the published rule, status, exact contract quote, location, analysis, and suggested language. The Word add-in can apply a suggestion as a tracked change with an explanatory comment or attach the analysis as a comment only.

The current one-pass safety limits are 150,000 extracted characters per imported playbook, 100,000 serialized characters per published playbook, and 180,000 characters per reviewed contract. Oversized inputs fail explicitly instead of being silently truncated.
