import {
  createCipheriv, createDecipheriv, createHmac, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { getKeyVaultConfig } from "./config";
import { deriveServerRelayKey } from "./serverSession";

export type RunRow = {
  id: string;
  run_key: string;
  surface: string;
  user_id: string;
  meta: Record<string, unknown>;
  owner_instance: string;
  owner_token: string;
  fence: string;
  state: "running" | "stopping" | "finished" | "owner_lost";
  seq: string;
  started_at: Date;
  lease_expires_at: Date;
  terminal_reason: string | null;
};

type RelayMessage = {
  kind: "request" | "response";
  requestId: string;
  op?: string;
  data?: unknown;
  ok?: boolean;
};
type Envelope = {
  v: 1; from: string; to: string; id: string; part: number; total: number;
  iv: string; data: string; tag: string; mac: string;
};
type Assembly = { parts: (string | undefined)[]; bytes: number; expires: NodeJS.Timeout };

// Run leases and node registrations last 30 seconds and finished runs are
// retained for 60 seconds; those intervals are SQL literals in the queries
// below (clock_timestamp() + interval ...), not parameters.
// A 2 MB Word result gains a small JSON envelope before encryption.
const MAX_RELAY_BYTES = 3 * 1024 * 1024;
const FRAGMENT_BYTES = 2700;
const CHANNEL_PREFIX = "mike_stream_";

function channel(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid stream node id");
  return `${CHANNEL_PREFIX}${id.replaceAll("-", "")}`;
}

function canonicalEnvelope(e: Omit<Envelope, "mac">): string {
  return JSON.stringify([e.v, e.from, e.to, e.id, e.part, e.total, e.iv, e.data, e.tag]);
}

/**
 * PostgreSQL stores ownership/routing metadata only. Payloads traverse
 * short-lived, encrypted NOTIFY messages and are never written to a table.
 * This object is initialized before listen(); buildApp remains side-effect free.
 */
export class StreamRunCluster {
  readonly instanceId = randomUUID();
  private readonly pair = generateKeyPairSync("x25519");
  private readonly publicKey = this.pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  private readonly pool: Pool;
  private listener: Client;
  private readonly connectionConfig: ConstructorParameters<typeof Client>[0];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly macKey: Buffer;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: NodeJS.Timeout }>();
  private readonly assemblies = new Map<string, Assembly>();
  private readonly peerKeys = new Map<string, { key: string; expires: number }>();
  private handler: ((op: string, data: unknown) => Promise<unknown>) | null = null;
  private pulse: NodeJS.Timeout | null = null;
  private stopped = false;

  private constructor(uri: string, ssl: boolean, relayKey?: Buffer) {
    this.macKey = relayKey ?? deriveServerRelayKey();
    const config = { connectionString: uri, ssl: ssl ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 10_000 };
    this.connectionConfig = config;
    this.pool = new Pool({ ...config, max: 4 });
    this.listener = new Client(config);
  }

  static async start(): Promise<StreamRunCluster> {
    let uri = "";
    if (process.env.KEY_VAULT_NAME) {
      try { uri = await getKeyVaultConfig("pgrst-db-uri"); }
      catch (error) { if (!process.env.STREAM_RUN_DATABASE_URL) throw error; }
    }
    uri ||= process.env.STREAM_RUN_DATABASE_URL ?? "";
    if (!uri) throw new Error("Stream run database URI unavailable");
    const parsed = new URL(uri);
    if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) throw new Error("Stream run database URI must be PostgreSQL");
    if (parsed.port && parsed.port !== "5432") throw new Error("Stream run database requires direct PostgreSQL port 5432");
    const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    const ssl = !(process.env.NODE_ENV === "test" && local);
    const cluster = new StreamRunCluster(uri, ssl);
    await cluster.initialize();
    return cluster;
  }

  /** Disposable loopback PostgreSQL seam for two-real-connection tests. */
  static async startForTests(uri: string, relayKey: Buffer): Promise<StreamRunCluster> {
    const parsed = new URL(uri);
    if (process.env.NODE_ENV !== "test" || !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
        || relayKey.length !== 32) throw new Error("Test stream relay requires loopback PostgreSQL and a 32-byte key");
    const cluster = new StreamRunCluster(uri, false, relayKey);
    await cluster.initialize();
    return cluster;
  }

  private async initialize(): Promise<void> {
    await this.connectListener(this.listener);
    await this.withClient(async (c) => {
      await c.query(
        "insert into public.stream_run_nodes(instance_id, public_key, expires_at) values($1,$2,clock_timestamp()+interval '30 seconds') on conflict(instance_id) do update set public_key=excluded.public_key,expires_at=excluded.expires_at",
        [this.instanceId, this.publicKey],
      );
      await c.query("select id from public.stream_runs limit 1");
    });
    this.pulse = setInterval(() => { void this.heartbeat().catch(() => {
      // A transient pool fault must not silently disable the listener;
      // ownership renewals independently fail closed while PostgreSQL is down.
    }); }, 5_000);
    this.pulse.unref();
  }

  private async connectListener(listener: Client): Promise<void> {
    await listener.connect();
    await listener.query("SET ROLE service_role");
    // LISTEN is committed before any ownership lookup or relay request.
    await listener.query(`LISTEN ${channel(this.instanceId)}`);
    listener.on("notification", (notice) => { if (notice.payload) void this.receive(notice.payload); });
    const reconnect = () => {
      if (this.stopped || this.reconnectTimer || listener !== this.listener) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.stopped) return;
        const next = new Client(this.connectionConfig);
        void this.connectListener(next).then(() => {
          this.listener = next;
        }).catch(() => {
          void next.end().catch(() => {});
          reconnect();
        });
      }, 1000);
      this.reconnectTimer.unref();
    };
    listener.on("error", reconnect);
    listener.on("end", reconnect);
  }

  setHandler(handler: (op: string, data: unknown) => Promise<unknown>): void { this.handler = handler; }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.pulse) clearInterval(this.pulse);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Stream relay closed")); }
    this.pending.clear();
    await Promise.allSettled([this.listener.end(), this.pool.end()]);
  }

  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error("Stream relay unavailable");
    const client = await this.pool.connect();
    try {
      await client.query("SET ROLE service_role");
      return await fn(client);
    } finally { client.release(); }
  }

  private async heartbeat(): Promise<void> {
    await this.withClient(async (c) => {
      await c.query("update public.stream_run_nodes set expires_at=clock_timestamp()+interval '30 seconds' where instance_id=$1", [this.instanceId]);
      await c.query("delete from public.stream_run_tool_calls where deadline_at < clock_timestamp() and state <> 'pending'");
      await c.query("delete from public.stream_runs where retention_expires_at < clock_timestamp()");
    });
  }

  private async peerKey(id: string): Promise<string> {
    const cached = this.peerKeys.get(id);
    if (cached && cached.expires > Date.now()) return cached.key;
    const result = await this.withClient((c) => c.query<{ public_key: string }>(
      "select public_key from public.stream_run_nodes where instance_id=$1 and expires_at>clock_timestamp()", [id],
    ));
    const key = result.rows[0]?.public_key;
    if (!key) throw new Error("Stream owner unavailable");
    this.peerKeys.set(id, { key, expires: Date.now() + 10_000 });
    return key;
  }

  private async sharedKey(peer: string): Promise<Buffer> {
    const key = createPublicKey({ key: Buffer.from(await this.peerKey(peer), "base64"), format: "der", type: "spki" });
    const secret = diffieHellman({ privateKey: this.pair.privateKey, publicKey: key });
    const nodes = [this.instanceId, peer].sort().join(":");
    return Buffer.from(hkdfSync("sha256", secret, this.macKey, Buffer.from(`mike-stream-run-v1:${nodes}`), 32));
  }

  private async send(to: string, message: RelayMessage): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(message));
    if (bytes.length > MAX_RELAY_BYTES) throw new Error("Stream relay payload exceeds limit");
    const key = await this.sharedKey(to);
    const id = randomUUID();
    const total = Math.max(1, Math.ceil(bytes.length / FRAGMENT_BYTES));
    for (let part = 0; part < total; part++) {
      const iv = randomBytes(12);
      const head = { v: 1 as const, from: this.instanceId, to, id, part, total };
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(JSON.stringify(head)));
      const data = Buffer.concat([cipher.update(bytes.subarray(part * FRAGMENT_BYTES, (part + 1) * FRAGMENT_BYTES)), cipher.final()]).toString("base64");
      const raw = { ...head, iv: iv.toString("base64"), data, tag: cipher.getAuthTag().toString("base64") };
      const envelope: Envelope = { ...raw, mac: createHmac("sha256", this.macKey).update(canonicalEnvelope(raw)).digest("base64") };
      await this.withClient((c) => c.query("select pg_notify($1,$2)", [channel(to), JSON.stringify(envelope)]).then(() => undefined));
    }
  }

  private async receive(encoded: string): Promise<void> {
    try {
      const e = JSON.parse(encoded) as Envelope;
      if (e.v !== 1 || e.to !== this.instanceId || !Number.isInteger(e.part) || !Number.isInteger(e.total)
          || e.total < 1 || e.total > 2048 || e.part < 0 || e.part >= e.total) return;
      const { mac, ...unsigned } = e;
      const expected = createHmac("sha256", this.macKey).update(canonicalEnvelope(unsigned)).digest();
      const provided = Buffer.from(mac, "base64");
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return;
      const key = await this.sharedKey(e.from);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
      decipher.setAAD(Buffer.from(JSON.stringify({ v: e.v, from: e.from, to: e.to, id: e.id, part: e.part, total: e.total })));
      decipher.setAuthTag(Buffer.from(e.tag, "base64"));
      const part = Buffer.concat([decipher.update(Buffer.from(e.data, "base64")), decipher.final()]).toString("base64");
      const assemblyKey = `${e.from}:${e.id}`;
      let assembly = this.assemblies.get(assemblyKey);
      if (!assembly) {
        const expires = setTimeout(() => this.assemblies.delete(assemblyKey), 10_000);
        expires.unref();
        assembly = { parts: Array(e.total), bytes: 0, expires };
        this.assemblies.set(assemblyKey, assembly);
      }
      if (assembly.parts.length !== e.total || assembly.parts[e.part] !== undefined) return;
      assembly.parts[e.part] = part;
      assembly.bytes += Buffer.from(part, "base64").length;
      if (assembly.bytes > MAX_RELAY_BYTES) { clearTimeout(assembly.expires); this.assemblies.delete(assemblyKey); return; }
      if (assembly.parts.every((item) => item !== undefined)) {
        clearTimeout(assembly.expires);
        this.assemblies.delete(assemblyKey);
        const message = JSON.parse(Buffer.concat(assembly.parts.map((item) => Buffer.from(item!, "base64"))).toString("utf8")) as RelayMessage;
        await this.dispatch(e.from, message);
      }
    } catch { /* malformed or stale encrypted notifications are ignored */ }
  }

  private async dispatch(from: string, message: RelayMessage): Promise<void> {
    if (message.kind === "response") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error("Stream relay request failed"));
      return;
    }
    if (message.kind !== "request" || !message.op || !this.handler) return;
    try {
      const data = await this.handler(message.op, message.data);
      await this.send(from, { kind: "response", requestId: message.requestId, ok: true, data });
    } catch {
      await this.send(from, { kind: "response", requestId: message.requestId, ok: false });
    }
  }

  async request<T>(to: string, op: string, data: unknown, timeoutMs = 5_000): Promise<T> {
    const requestId = randomUUID();
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("Stream relay timed out")); }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
    try { await this.send(to, { kind: "request", requestId, op, data }); }
    catch (error) { const entry = this.pending.get(requestId); if (entry) { clearTimeout(entry.timer); this.pending.delete(requestId); entry.reject(error); } }
    return result;
  }

  async claim(args: { id: string; key: string; userId: string; meta: Record<string, unknown>; surface: string }): Promise<RunRow | null> {
    const token = randomUUID();
    return this.withClient(async (c) => {
      await c.query("begin");
      try {
        await c.query("select pg_advisory_xact_lock(hashtextextended($1, 540))", [args.key]);
        await c.query(`update public.stream_runs set state='owner_lost', terminal_reason='owner_lost',
          finished_at=clock_timestamp(), retention_expires_at=clock_timestamp()+interval '60 seconds'
          where run_key=$1 and state in ('running','stopping') and
          (lease_expires_at<=clock_timestamp() or lifetime_expires_at<=clock_timestamp() or
           (stop_deadline_at is not null and stop_deadline_at<=clock_timestamp()))`, [args.key]);
        const occupied = await c.query("select id from public.stream_runs where run_key=$1 and state in ('running','stopping')", [args.key]);
        if (occupied.rowCount) { await c.query("commit"); return null; }
        const inserted = await c.query<RunRow>(`insert into public.stream_runs
          (id,run_key,surface,user_id,meta,owner_instance,owner_token,state,lease_expires_at,lifetime_expires_at)
          values($1,$2,$3,$4,$5,$6,$7,'running',clock_timestamp()+interval '30 seconds',clock_timestamp()+interval '30 minutes') returning *`,
          [args.id, args.key, args.surface, args.userId, args.meta, this.instanceId, token]);
        await c.query("commit");
        return inserted.rows[0];
      } catch (error) { await c.query("rollback"); throw error; }
    });
  }

  async lookup(id: string): Promise<RunRow | null> {
    return this.withClient(async (c) => {
      await c.query(`update public.stream_runs set state='owner_lost', terminal_reason='owner_lost',
        finished_at=clock_timestamp(), retention_expires_at=clock_timestamp()+interval '60 seconds'
        where id=$1 and state in ('running','stopping') and
        (lease_expires_at<=clock_timestamp() or lifetime_expires_at<=clock_timestamp() or
         (stop_deadline_at is not null and stop_deadline_at<=clock_timestamp()))`, [id]);
      const result = await c.query<RunRow>("select * from public.stream_runs where id=$1 and (retention_expires_at is null or retention_expires_at>clock_timestamp())", [id]);
      return result.rows[0] ?? null;
    });
  }

  async active(key: string): Promise<RunRow | null> {
    return this.withClient(async (c) => {
      await c.query(`update public.stream_runs set state='owner_lost', terminal_reason='owner_lost',
        finished_at=clock_timestamp(), retention_expires_at=clock_timestamp()+interval '60 seconds'
        where run_key=$1 and state in ('running','stopping') and
        (lease_expires_at<=clock_timestamp() or lifetime_expires_at<=clock_timestamp() or
         (stop_deadline_at is not null and stop_deadline_at<=clock_timestamp()))`, [key]);
      const result = await c.query<RunRow>("select * from public.stream_runs where run_key=$1 and state in ('running','stopping') order by started_at desc limit 1", [key]);
      return result.rows[0] ?? null;
    });
  }

  async renew(row: RunRow): Promise<RunRow | null> {
    const result = await this.withClient((c) => c.query<RunRow>(`update public.stream_runs
      set lease_expires_at=clock_timestamp()+interval '30 seconds'
      where id=$1 and owner_instance=$2 and owner_token=$3 and fence=$4 and state in ('running','stopping')
        and lease_expires_at>clock_timestamp() and lifetime_expires_at>clock_timestamp()
        and (stop_deadline_at is null or stop_deadline_at>clock_timestamp()) returning *`,
      [row.id, this.instanceId, row.owner_token, row.fence]));
    return result.rows[0] ?? null;
  }

  async advertise(row: RunRow, seq: number): Promise<boolean> {
    const result = await this.withClient((c) => c.query(`update public.stream_runs set seq=greatest(seq,$5)
      where id=$1 and owner_instance=$2 and owner_token=$3 and fence=$4 and state in ('running','stopping')
        and lease_expires_at>clock_timestamp()`, [row.id, this.instanceId, row.owner_token, row.fence, seq]));
    return result.rowCount === 1;
  }

  async stop(id: string, fence: string): Promise<RunRow | null> {
    const result = await this.withClient((c) => c.query<RunRow>(`update public.stream_runs
      set state='stopping',stop_deadline_at=coalesce(stop_deadline_at,clock_timestamp()+interval '30 seconds')
      where id=$1 and fence=$2 and state in ('running','stopping') and lease_expires_at>clock_timestamp()
      returning *`, [id, fence]));
    return result.rows[0] ?? this.lookup(id);
  }

  async finish(row: RunRow, seq: number): Promise<boolean> {
    const result = await this.withClient((c) => c.query(`update public.stream_runs
      set state='finished',seq=greatest(seq,$5),finished_at=clock_timestamp(),
          retention_expires_at=clock_timestamp()+interval '60 seconds'
      where id=$1 and owner_instance=$2 and owner_token=$3 and fence=$4
        and state in ('running','stopping') and lease_expires_at>clock_timestamp()`,
      [row.id, this.instanceId, row.owner_token, row.fence, seq]));
    return result.rowCount === 1;
  }

  async registerToolCall(row: RunRow, callId: string, userId: string, timeoutMs: number): Promise<boolean> {
    const result = await this.withClient((c) => c.query(`insert into public.stream_run_tool_calls
      (call_id,run_id,fence,user_id,owner_instance,state,deadline_at)
      select $1,id,fence,$2,owner_instance,'pending',clock_timestamp()+($3::int * interval '1 millisecond')
      from public.stream_runs where id=$4 and owner_instance=$5 and owner_token=$6 and fence=$7
      and state in ('running','stopping') and lease_expires_at>clock_timestamp()`,
      [callId,userId,timeoutMs,row.id,this.instanceId,row.owner_token,row.fence]));
    return result.rowCount === 1;
  }

  async toolCall(callId: string, userId: string): Promise<{ owner_instance: string; run_id: string; fence: string } | null> {
    const result = await this.withClient((c) => c.query<{ owner_instance: string; run_id: string; fence: string }>(
      `select t.owner_instance,t.run_id,t.fence from public.stream_run_tool_calls t
       join public.stream_runs r on r.id=t.run_id and r.fence=t.fence
       where t.call_id=$1 and t.user_id=$2 and t.state='pending' and t.deadline_at>clock_timestamp()
         and r.state in ('running','stopping') and r.lease_expires_at>clock_timestamp()`, [callId,userId]));
    return result.rows[0] ?? null;
  }

  async settleToolCall(callId: string, userId: string): Promise<boolean> {
    const result = await this.withClient((c) => c.query(`update public.stream_run_tool_calls set state='settled'
      where call_id=$1 and user_id=$2 and state='pending' and deadline_at>clock_timestamp()`, [callId,userId]));
    return result.rowCount === 1;
  }
}

let activeCluster: StreamRunCluster | null = null;
export async function initStreamRunCluster(): Promise<void> {
  if (activeCluster) return;
  activeCluster = await StreamRunCluster.start();
}
export function streamRunCluster(): StreamRunCluster | null { return activeCluster; }
export async function closeStreamRunCluster(): Promise<void> {
  const cluster = activeCluster;
  activeCluster = null;
  if (cluster) await cluster.close();
}
