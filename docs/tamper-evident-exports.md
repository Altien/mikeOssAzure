# Tamper-evident exports

Mike hashes a document version's bytes with SHA-256 whenever it writes them.
`GET /projects/:projectId/export` returns a manifest containing those hashes and
the accept/reject trail.

To check an exported file, calculate its SHA-256 digest and compare it with the
corresponding manifest entry:

```bash
shasum -a 256 lease.docx
```

Versions written before hashing support was introduced have a `null` hash. They
are reported as unverifiable rather than falsely verified.

## Deleted versions

Soft-deleted versions remain in the manifest with their `deleted_at` value. A
trail that omitted them would provide a weaker attestation. This also means the
filename and timestamps of a deleted version remain visible to anyone who can
access the project export.

## Manifest digest

The manifest contains a SHA-256 `digest` over its body, excluding the `digest`
and `signature` fields. To reproduce it, serialize the parsed body with object
keys sorted, array order preserved, and no whitespace, then calculate its
SHA-256 digest.

## Optional Ed25519 signature

Set `MANIFEST_SIGNING_KEY` to an Ed25519 seed to sign the manifest digest:

```bash
openssl rand -hex 32
```

Use a dedicated secret. An unset key produces unsigned manifests whose document
hashes can still be checked.

The signature is calculated over:

1. The bytes `mike-project-manifest-v1`.
2. A NUL byte.
3. The manifest digest bytes.

It can be checked with any Ed25519 implementation:

```js
crypto.verify(
  null,
  Buffer.concat([
    Buffer.from("mike-project-manifest-v1\0"),
    Buffer.from(manifest.digest.value, "hex"),
  ]),
  publicKey,
  Buffer.from(manifest.signature.value, "hex"),
);
```

Obtain `publicKey` from `GET /manifest-signing-key`, not from the manifest.
Someone who edits a manifest can replace an embedded key and re-sign it, so an
embedded copy demonstrates internal consistency rather than provenance.

Rotating the signing key does not invalidate past exports, but verifiers need
the public key that was active when each export was created.
