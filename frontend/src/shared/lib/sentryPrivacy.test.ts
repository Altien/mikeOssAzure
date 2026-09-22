import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosticEnvelope, diagnosticEvent, diagnosticRoute, privacyBoundaryIntegration } from './sentryPrivacy';

const id = '8f1c2a3e-1234-4bcd-9e0f-1234567890ab';
const eventId = '1234567890abcdef1234567890abcdef';
afterEach(() => vi.restoreAllMocks());

describe('outbound telemetry privacy boundary', () => {
  it.each(['Synthetic_Client_Jane_Doe_NDA.pdf', 'Jane Doe medical claim', '秘密の依頼人契約.docx'])('drops client-controlled text in every event carrier: %s', privateName => {
    const out = diagnosticEvent({
      event_id: eventId, message: privateName, logentry: { message: privateName },
      transaction: privateName, fingerprint: [privateName], logger: privateName,
      request: { url: '/documents?filename=' + privateName, headers: { 'X-Custom-Secret': privateName }, query_string: privateName, data: privateName },
      user: { id: privateName }, server_name: privateName,
      breadcrumbs: [{ message: privateName, data: { filename: privateName } }],
      extra: { detail: privateName, name: privateName, message: privateName, error_stack: privateName, document_id: privateName },
      contexts: { trace: { data: privateName }, os: { name: privateName } },
      tags: { component: privateName, stage: privateName, document_id: privateName, error_code: privateName, http_route: '/documents/' + privateName + '?q=' + privateName },
      exception: { values: [{ type: privateName, value: privateName, module: privateName, mechanism: { data: privateName }, stacktrace: { frames: [{ filename: privateName, function: privateName, vars: { name: privateName }, context_line: privateName }] } }] },
      debug_meta: { images: [{ type: 'sourcemap', code_file: privateName, debug_id: privateName }] },
      future_sdk_field: privateName,
    });
    expect(JSON.stringify(out)).not.toContain(privateName);
    expect(out.tags).toEqual({ http_route: '/documents/:id' });
    expect(out).not.toHaveProperty('request');
    expect(out).not.toHaveProperty('breadcrumbs');
    expect(out).not.toHaveProperty('user');
  });

  it('retains actionable controlled diagnostics, correlation IDs, stack lines and source-map IDs', () => {
    const out = diagnosticEvent({
      event_id: eventId, timestamp: 123, level: 'error', platform: 'javascript', release: 'mike@abc123', environment: 'self-hosted',
      tags: { service: 'mike-backend', component: 'upload-worker', stage: 'conversion', http_method: 'POST', http_route: '/api/projects/' + id + '/documents', http_status: '500', request_id: id, network: true, project: 'false', error_code: 'internal_error' },
      extra: { document_id: id, filename: 'Private NDA.pdf' },
      exception: { values: [{ type: 'TypeError', value: 'Private NDA.pdf', mechanism: { handled: true, data: 'secret' }, stacktrace: { frames: [{ filename: '/Users/private/work/mike/backend/src/convert.ts', abs_path: '/Users/private/work/mike/backend/src/convert.ts', lineno: 42, colno: 7, in_app: true, function: 'privateName', context_line: 'privateName', vars: { secret: true } }] } }] },
      debug_meta: { images: [{ type: 'sourcemap', code_file: '/Users/private/work/mike/backend/src/convert.ts', debug_id: id }] },
    });
    expect(out).toMatchObject({ event_id: eventId, timestamp: 123, level: 'error', release: 'mike@abc123', environment: 'self-hosted', extra: { document_id: id }, tags: { request_id: id, http_route: '/api/projects/:id/documents', http_status: 500 } });
    expect(out.exception).toEqual({ values: [{ type: 'TypeError', value: 'Failure in upload-worker / conversion / POST / /api/projects/:id/documents / 500 / internal_error', mechanism: { type: 'generic', handled: true }, stacktrace: { frames: [{ filename: 'backend/src/convert.ts', abs_path: 'backend/src/convert.ts', lineno: 42, colno: 7, in_app: true }] } }] });
    expect(out.debug_meta).toEqual({ images: [{ type: 'sourcemap', code_file: 'backend/src/convert.ts', debug_id: id }] });
    expect(JSON.stringify(out)).not.toContain('private');
  });

  it('handles browser bundle paths and removes URL credentials, query, fragment and host', () => {
    const out = diagnosticEvent({ stacktrace: { frames: [{ filename: 'https://private.example/_next/static/chunks/app.js?filename=Private.pdf#secret', lineno: 1, colno: 30 }, { filename: '/home/private/contract.pdf' }, { filename: undefined }] } });
    expect(out.stacktrace).toEqual({ frames: [{ filename: '_next/static/chunks/app.js', lineno: 1, colno: 30 }] });
    expect(out.message).toBe('Failure in application');
    expect(diagnosticRoute('https://private.example/api/documents/Private.pdf?q=private')).toBe('/api/documents/:id');
    expect(diagnosticRoute('')).toBe('/');
  });

  it('keeps nested console stack locations and Word bundle source-map links without their prose', () => {
    const out = diagnosticEvent({ extra: { error_stack: 'Error: Private NDA.pdf\n    at convert (/work/mike/backend/src/convert.ts:42:7)\ninvalid' }, debug_meta: { images: [{ type: 'sourcemap', code_file: 'http://localhost:3100/taskpane.1234abcd.js', debug_id: id }] } });
    expect(out.stacktrace).toEqual({ frames: [{ filename: 'backend/src/convert.ts', lineno: 42, colno: 7 }] });
    expect(out.debug_meta).toEqual({ images: [{ type: 'sourcemap', code_file: 'taskpane.1234abcd.js', debug_id: id }] });
    expect(JSON.stringify(out)).not.toContain('Private NDA');
    expect(diagnosticEvent({ tags: { office_host: 'Word', office_platform: 'Mac', office_version: '16.0.123', job_kind: 'extraction.extract' } }).tags).toEqual({ office_host: 'Word', office_platform: 'Mac', office_version: '16.0.123', job_kind: 'extraction.extract' });
  });

  it('ignores tag names inherited from Object.prototype', () => {
    expect(diagnosticEvent({ tags: { constructor: 'constructor', toString: 'toString' } }).tags).toEqual({});
  });

  it.each(['session', 'sessions', 'client_report', 'transaction', 'attachment', 'replay_event', 'replay_recording', 'log', 'span', 'metric', 'profile', 'feedback', 'future_item'])('rejects %s items before network serialization', type => {
    expect(diagnosticEnvelope([{ trace: { transaction: 'Private.pdf' } }, [[{ type, filename: 'Private.pdf' }, { did: 'private-user' }]]])).toBeNull();
  });

  it('rebuilds mixed envelopes and removes payload sizes and arbitrary envelope metadata', () => {
    const safe = diagnosticEnvelope([{ event_id: eventId, trace: { transaction: 'Private.pdf' }, private: true }, [[{ type: 'session' }, { did: 'private' }], [{ type: 'event', length: 999, filename: 'Private.pdf' }, { message: 'Private.pdf' }]]]);
    expect(safe).toEqual([{ event_id: eventId }, [[{ type: 'event' }, diagnosticEvent({})]]]);
    expect(diagnosticEnvelope([{}, [[{ type: 'event' }, null]]])).toEqual([{}, [[{ type: 'event' }, diagnosticEvent({})]]]);
  });

  it('routes tunneled reports using the configured public DSN, never private envelope text', async () => {
    const send = vi.fn().mockResolvedValue({ statusCode: 200 });
    const transport = { send };
    privacyBoundaryIntegration().setup({ getTransport: () => transport, getDsn: () => ({ protocol: 'https', publicKey: 'public-key', host: 'sentry.example', port: '443', path: 'ingest', projectId: '123' }) });
    await transport.send([{ dsn: 'Private NDA.pdf' }, [[{ type: 'event' }, {}]]]);
    expect(send).toHaveBeenCalledWith([{ dsn: 'https://public-key@sentry.example:443/ingest/123' }, [[{ type: 'event' }, diagnosticEvent({})]]]);
  });

  it('bounds event volume across distinct issues, preserves transport responses and flush ownership', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const send = vi.fn().mockResolvedValue({ statusCode: 503 });
    const transport = { send, flush: vi.fn() };
    privacyBoundaryIntegration().setup({ getTransport: () => transport });
    const event: Parameters<typeof diagnosticEnvelope>[0] = [{}, [[{ type: 'event' }, { message: 'private' }]]];
    expect(await transport.send(event)).toEqual({ statusCode: 503 });
    for (let n = 0; n < 70; n++) await transport.send(event);
    expect(send).toHaveBeenCalledTimes(60);
    await transport.send([{}, [[{ type: 'session' }, { did: 'private' }]]]);
    expect(send).toHaveBeenCalledTimes(60);
    clock.mockReturnValue(61_000);
    await transport.send(event);
    expect(send).toHaveBeenCalledTimes(61);
    expect(transport.flush).not.toHaveBeenCalled();
    expect(() => privacyBoundaryIntegration().setup({ getTransport: () => undefined })).not.toThrow();
  });
});
