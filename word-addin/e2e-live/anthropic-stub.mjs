// Minimal Anthropic Messages API stand-in for driving the Mike stack when no
// funded API key is available. Speaks just enough of the streaming protocol
// for @anthropic-ai/sdk's messages.stream()/finalMessage() to work:
// message_start -> content_block_start -> content_block_delta* ->
// content_block_stop -> message_delta -> message_stop.
//
// Responses are scripted per prompt shape so the add-in's redline contract
// (ORIGINAL/REPLACEMENT/REASON) is exercised exactly as a real model would.
// Each flow targets DIFFERENT document text so tracked changes never collide:
//   chat redlines  -> "Suplier", "reciept"
//   proofread      -> "Schedual", "writen"
//   anonymise      -> "John Smith", "10 Downing Street, London"
//   improve #1     -> clause 4 ("do the work good")     [tracked replace]
//   improve #2     -> clause 5 ("keep things confidential") [plain replace]
import http from "node:http";

const PORT = 4141;

function pickResponse(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const text =
    typeof last?.content === "string"
      ? last.content
      : (last?.content ?? [])
          .map((block) => (typeof block === "string" ? block : block.text ?? ""))
          .join("\n");

  // The proofread prompt is instruction-only; the document body arrives via
  // the fenced document_context in the system prompt, not the user turn.
  if (text.includes("Proofread the legal document provided as document context")) {
    return [
      "ORIGINAL: described in Schedual 1",
      "REPLACEMENT: described in Schedule 1",
      "REASON: Spelling — \"Schedual\" should be \"Schedule\".",
      "",
      "ORIGINAL: sixty (60) days writen notice",
      "REPLACEMENT: sixty (60) days' written notice",
      "REASON: Spelling — \"writen\" should be \"written\" (with possessive apostrophe).",
    ].join("\n");
  }
  if (text.includes("personally identifiable information")) {
    return [
      "ORIGINAL: John Smith",
      "REPLACEMENT: [PARTY A]",
      "REASON: Person name.",
      "",
      "ORIGINAL: 10 Downing Street, London",
      "REPLACEMENT: [ADDRESS 1]",
      "REASON: Postal address.",
    ].join("\n");
  }
  if (text.includes("Draft a professional legal clause")) {
    return [
      "Confidentiality. Each party (the \"Receiving Party\") shall keep confidential all non-public information disclosed by the other party (the \"Disclosing Party\") in connection with this Agreement, shall use such information solely to perform its obligations hereunder, and shall not disclose it to any third party except to employees and advisers who need to know it and are bound by obligations of confidence no less protective than this clause.",
      "",
      "This clause shall survive termination of this Agreement for a period of five (5) years.",
    ].join("\n");
  }
  if (text.includes("character-for-character")) {
    return [
      "I reviewed the agreement and found two spelling errors worth fixing:",
      "",
      "ORIGINAL: The Suplier shall provide",
      "REPLACEMENT: The Supplier shall provide",
      "REASON: Spelling — \"Suplier\" should be \"Supplier\".",
      "",
      "ORIGINAL: within thirty (30) days of reciept",
      "REPLACEMENT: within thirty (30) days of receipt",
      "REASON: Spelling — \"reciept\" should be \"receipt\".",
      "",
      "Both fixes preserve the clause numbering and meaning.",
    ].join("\n");
  }
  if (text.includes("Rewrite the following selected legal text")) {
    if (text.includes("keep things confidential")) {
      return "5. The parties shall maintain the confidentiality of all information exchanged in connection with this agreement.";
    }
    if (text.includes("do the work good")) {
      return "4. The Consultant shall perform the services diligently, to a professional standard, and in a timely manner.";
    }
    return "The Supplier shall provide the consulting services described in Schedule 1 exercising reasonable skill and care.";
  }
  return "This is a services agreement between Acme Consulting Ltd and a consultant. It covers the services to be provided (clause 1), payment terms of thirty days (clause 2), termination on sixty days' notice (clause 3), the standard of work required (clause 4), and confidentiality between the parties (clause 5).";
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((req, res) => {
  if (!req.url.includes("/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    const reply = pickResponse(body);
    const model = body.model ?? "claude-sonnet-4-6";
    const id = `msg_stub_${Date.now()}`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    sse(res, "message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });

    // Stream in word-ish chunks with small delays so the UI visibly streams.
    const chunks = reply.match(/.{1,24}/gs) ?? [];
    for (const chunk of chunks) {
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunk },
      });
      await new Promise((r) => setTimeout(r, 45));
    }

    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: Math.ceil(reply.length / 4) },
    });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`anthropic stub listening on http://127.0.0.1:${PORT}`);
});
