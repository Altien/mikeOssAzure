# Document extraction: capacity, limits, and failures

CPU-heavy document parsing runs outside the API/background worker process.
Each calling thread has one parser slot. Each admitted file starts a fresh Node
child process; completion, failure, or timeout retires that process and its
process group. This trades parser startup overhead for returning all parser
memory after every file and cleaning up LibreOffice descendants consistently.

This path covers search indexing, chat document reads, tabular source parsing,
and legacy Office text precomputation. It does not move the upload conversion
pipeline, document editing, or every other CPU-heavy backend operation.

## Job ownership and admission

`document.extract_text` and `document.precompute_text` reserve a parser slot
before fetching metadata or downloading bytes. If occupied, they throw the
existing `DbJobDeferredError`: the runner returns the fenced claim to `pending`,
refunds that claim's attempt, and schedules another attempt after 30 seconds.
They never wait in a process-local parser queue while their 600-second DB lease
ages. The existing attempt/claimed-at fencing remains unchanged. Inline jobs
that were never claimed remain pending when busy.

Interactive callers may wait for a slot, but at most eight requests and 150 MiB
of already-loaded buffers can be queued per calling thread. Waiters expire after
30 seconds with `ExtractionBusyError`; this is a capacity failure, not a
permanent document-size failure. Chat returns a busy/retry message. Tabular
review propagates a refused source instead of asking the model to fill cells
from empty content. Chat and tabular downloads start only after admission.

Parsing takes at most 180 seconds by default. `EXTRACTION_TIMEOUT_MS` is clamped
to 300 seconds to leave room within the DB lease for download and publication.
This is a parser deadline, not a deadline for the entire job. Slow database or
storage operations can still exhaust a lease; existing fencing protects job
finalization, and general I/O deadlines/lease renewal are separate concerns.

## Memory and decompression

On Linux (kernel 4.7 or newer), `prlimit` applies both soft and hard limits before
Node starts:

- `RLIMIT_DATA`: `EXTRACTION_MAX_MEMORY_MB`, default 1024 MiB. Bounds writable
  data allocations, including JavaScript heap and native/ArrayBuffer memory.
- `RLIMIT_AS`: the data budget plus 1024 MiB. Bounds the entire virtual address
  space while leaving room for V8 code reservations and the development TS
  loader. Virtual reservations are not the same as resident memory.
- Core dumps are disabled. The JavaScript old-generation heap is additionally
  limited to half the data budget; WebAssembly's large virtual cage is disabled.
  glibc is limited to two malloc arenas so per-thread virtual reservations do
  not exhaust the address-space limit while actual memory usage is still low.

Limits are inherited by conversion subprocesses but apply to **each process**,
not to the sum of a process tree or all backend replicas. Size the deployment
for concurrent parser groups, upload conversions, API memory, and database/
Redis services if colocated. Use a container/cgroup limit for an aggregate
worker-service budget; a parser process boundary alone does not provide that.
Do not treat the configured 1024 MiB as the backend's total memory requirement.

macOS and Windows retain subprocess, JS heap, input, archive, output, and timeout
bounds, but do not have the Linux data/address-space limits. Use the Linux image
when the OS memory guarantees are required. On POSIX, termination targets the
whole parser process group; Windows uses `taskkill /T /F` for descendants.

ZIP-based Office documents are checked with a lazy streaming ZIP reader before
parsing. Every entry is visited, including duplicates and alleged empty entries;
actual expansion and declared sizes are validated. The combined expansion limit
is `EXTRACTION_MAX_EXPANDED_MB` (default 256 MiB), capped at one quarter of the
memory budget, with at most 10,000 entries. Source bytes are limited to 150 MiB
and extracted text to 16 MiB before IPC. Files over these limits are refused,
not truncated. PDF and legacy binary formats rely on subprocess OS limits and
the deadline rather than ZIP expansion checks.

Parser IPC receives only source bytes, operation, and file type. The child gets
a restricted environment without application credentials or inherited
`NODE_OPTIONS`, and its own temporary directory, removed after exit. This is a
resource boundary, not a general security sandbox for arbitrary hostile code.

`EXTRACTION_ISOLATION=off` disables process, archive, output, timeout, and OS
memory protection. It exists for parser mocks and emergency compatibility, not
as the recommended production configuration.

## Deployment modes

| Mode | Background coordination | Parser slots |
| --- | --- | --- |
| `WORKERS_MODE=thread` | Separate upload and jobs threads in the API process | One per calling thread; chat and jobs normally have independent slots |
| `WORKERS_MODE=inline` | Both roles share the API thread | One shared slot |
| `WORKERS_MODE=none` + `node dist/worker.js` | API and standalone worker are separate processes; standalone roles share a thread | Separate API and worker slots |

Extra worker replicas add capacity and memory demand. Database claims partition
work across replicas. Increasing generic job concurrency does not increase the
number of parser slots.

Apply PR #721's `20261027_01_document_text_failed_jobs.sql` migration before
rollout. This follow-up adds no migration. A limit failure becomes terminal
`failed/too_large` for indexed text; a precomputation limit is non-retryable.
The migration's trigger still handles worker-death failures and prevents
automatic requeue loops while preserving newer revisions and ready text.

## Verification

Run the extraction and indexing tests on the host, then in the Linux image:

```sh
npm test --prefix backend -- src/lib/extraction/__tests__ src/modules/documents/__tests__/documents.indexing.test.ts src/modules/documents/__tests__/documents.textJobs.test.ts
npm run build --prefix backend
npm run typecheck:test --prefix backend

docker build -f backend/Dockerfile -t mike-extraction-check .
docker run --rm --network none --memory 2g mike-extraction-check npm test -- src/lib/extraction/__tests__
```

The suite covers real XLSX/PDF parsing, timeout/OOM recovery, compressed expansion,
forged ZIP sizes, output bounds, bounded interactive waits, capacity deferral
without spending retry attempts, preserved claim fences, and process-group
termination. The native allocation-limit test runs only on Linux; Windows skips
the POSIX process-group test.

During rollout, inspect extraction deferrals, terminal `too_large` counts,
queue age, parser duration, and aggregate container memory. Sustained deferrals
mean demand exceeds configured parser capacity; scale measured capacity rather
than increasing generic job prefetch or allowing an unbounded local queue.
