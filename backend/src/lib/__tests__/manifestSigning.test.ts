import { describe, it, expect, afterEach } from "vitest";
import crypto from "crypto";
import {
    canonicalize,
    digestManifestBody,
    manifestPublicKey,
    sealManifest,
} from "../manifestSigning";

const KEY = "11".repeat(32);

afterEach(() => {
    delete process.env.MANIFEST_SIGNING_KEY;
});

const BODY = {
    manifest_version: 1,
    exported_at: "2026-07-31T10:00:00.000Z",
    project: { id: "p1", name: "Alpha" },
    documents: [
        { id: "d1", versions: [{ id: "v1", content_sha256: "a".repeat(64) }] },
    ],
};

/**
 * Rebuilds the signed payload and the public key independently of the module
 * under test, so these tests pin the wire format rather than agreeing with the
 * implementation. A recipient checking a manifest does exactly this.
 */
function payloadFor(digestHex: string, context = "mike-project-manifest-v1") {
    return Buffer.concat([
        Buffer.from(`${context}\0`, "utf8"),
        Buffer.from(digestHex, "hex"),
    ]);
}

function publicKeyOf(publicKeyHex: string): crypto.KeyObject {
    return crypto.createPublicKey({
        key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(publicKeyHex, "hex"),
        ]),
        format: "der",
        type: "spki",
    });
}

describe("canonicalize", () => {
    it("sorts object keys so parse order cannot change the digest", () => {
        expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
        expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    });

    it("sorts nested keys but preserves array order", () => {
        expect(canonicalize({ x: [{ b: 1, a: 2 }, 3] })).toBe(
            '{"x":[{"a":2,"b":1},3]}',
        );
        expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    });

    it("emits no whitespace, keeps nulls, drops undefined members", () => {
        expect(canonicalize(BODY)).not.toMatch(/\s/);
        expect(canonicalize({ a: null, b: undefined, c: 1 })).toBe(
            '{"a":null,"c":1}',
        );
    });

    it("refuses non-finite numbers rather than collapsing them onto null", () => {
        expect(() => canonicalize({ n: Number.NaN })).toThrow(/finite/);
        expect(() => canonicalize({ n: Infinity })).toThrow(/finite/);
    });

    it("refuses non-plain objects rather than serialising them wrongly", () => {
        // Each of these would otherwise pass silently and produce a digest
        // over something other than what the value represents.
        expect(() => canonicalize({ d: new Date() })).toThrow(/plain objects/);
        expect(() => canonicalize({ b: Buffer.from("x") })).toThrow(
            /plain objects/,
        );
        expect(() => canonicalize({ m: new Map() })).toThrow(/plain objects/);
        // Plain objects, including null-prototype ones, still pass.
        expect(canonicalize({ a: 1 })).toBe('{"a":1}');
        expect(canonicalize(Object.assign(Object.create(null), { a: 1 }))).toBe(
            '{"a":1}',
        );
    });

    it("gives a round-tripped manifest the same digest", () => {
        expect(digestManifestBody(JSON.parse(JSON.stringify(BODY))).value).toBe(
            digestManifestBody(BODY).value,
        );
    });
});

describe("sealManifest", () => {
    it("attaches a digest and a null signature when no key is set", () => {
        expect(manifestPublicKey()).toBeNull();
        const sealed = sealManifest(BODY);
        expect(sealed.signature).toBeNull();
        expect(sealed.digest.algorithm).toBe("sha256");
        expect(sealed.digest.value).toMatch(/^[0-9a-f]{64}$/);
    });

    it("publishes the same key it signs with, and never the seed", () => {
        process.env.MANIFEST_SIGNING_KEY = KEY;
        const sealed = sealManifest(BODY);
        const published = manifestPublicKey()!;
        expect(sealed.signature!.public_key).toBe(published.public_key);
        expect(sealed.signature!.key_id).toBe(published.key_id);
        expect(published.public_key).not.toBe(KEY);
    });

    it("produces a signature any Ed25519 implementation can check", () => {
        process.env.MANIFEST_SIGNING_KEY = KEY;
        const sealed = sealManifest(BODY);
        expect(
            crypto.verify(
                null,
                payloadFor(sealed.digest.value),
                publicKeyOf(sealed.signature!.public_key),
                Buffer.from(sealed.signature!.value, "hex"),
            ),
        ).toBe(true);
    });

    it("does not verify once the body has been edited", () => {
        process.env.MANIFEST_SIGNING_KEY = KEY;
        const sealed = sealManifest(BODY);
        const edited = { ...sealed, project: { id: "p1", name: "Beta" } };
        const { digest: _d, signature: _s, ...body } = edited;
        expect(digestManifestBody(body).value).not.toBe(sealed.digest.value);
    });

    it("rejects a signature made over a different domain context", () => {
        // Domain separation: the same key signing the same digest under
        // another label must not pass as a manifest signature, so one signing
        // key can serve other object types later without signatures crossing
        // between them.
        process.env.MANIFEST_SIGNING_KEY = KEY;
        const sealed = sealManifest(BODY);
        const privateKey = crypto.createPrivateKey({
            key: Buffer.concat([
                Buffer.from("302e020100300506032b657004220420", "hex"),
                Buffer.from(KEY, "hex"),
            ]),
            format: "der",
            type: "pkcs8",
        });
        const publicKey = publicKeyOf(sealed.signature!.public_key);

        for (const payload of [
            payloadFor(sealed.digest.value, "mike-project-manifest-v2"),
            payloadFor(sealed.digest.value, ""),
            Buffer.from(sealed.digest.value, "hex"), // bare digest, no context
        ]) {
            const foreign = crypto.sign(null, payload, privateKey);
            expect(
                crypto.verify(
                    null,
                    payloadFor(sealed.digest.value),
                    publicKey,
                    foreign,
                ),
            ).toBe(false);
        }
    });

    it("is deterministic for the same body and key", () => {
        process.env.MANIFEST_SIGNING_KEY = KEY;
        const a = sealManifest({ ...BODY });
        const b = sealManifest({ ...BODY });
        expect(a.digest.value).toBe(b.digest.value);
        expect(a.signature!.value).toBe(b.signature!.value);
    });

    it("throws on a malformed key rather than exporting unsigned", () => {
        process.env.MANIFEST_SIGNING_KEY = "not-hex";
        expect(() => sealManifest(BODY)).toThrow(/MANIFEST_SIGNING_KEY/);
        expect(() => manifestPublicKey()).toThrow(/MANIFEST_SIGNING_KEY/);

        process.env.MANIFEST_SIGNING_KEY = "ab".repeat(16);
        expect(() => sealManifest(BODY)).toThrow(/32-byte hex/);
    });
});
