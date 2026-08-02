import net from "net";

const blockedIpv4 = new net.BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8], // "This network" / unspecified
    ["10.0.0.0", 8], // RFC 1918 private-use
    ["100.64.0.0", 10], // Shared address space (carrier-grade NAT)
    ["127.0.0.0", 8], // Loopback
    ["169.254.0.0", 16], // Link-local
    ["172.16.0.0", 12], // RFC 1918 private-use
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // Documentation (TEST-NET-1)
    ["192.88.99.0", 24], // Deprecated 6to4 relay anycast
    ["192.168.0.0", 16], // RFC 1918 private-use
    ["198.18.0.0", 15], // Benchmarking
    ["198.51.100.0", 24], // Documentation (TEST-NET-2)
    ["203.0.113.0", 24], // Documentation (TEST-NET-3)
    ["224.0.0.0", 4], // Multicast
    ["240.0.0.0", 4], // Reserved (includes limited broadcast)
] as const) {
    blockedIpv4.addSubnet(network, prefix, "ipv4");
}

const blockedIpv6 = new net.BlockList();
for (const [network, prefix] of [
    ["2001::", 32], // Teredo
    ["2001:2::", 48], // Benchmarking
    ["2001:10::", 28], // Deprecated ORCHID
    ["2001:db8::", 32], // Documentation
    ["2002::", 16], // Deprecated 6to4 transition space
    ["3fff::", 20], // Documentation
] as const) {
    blockedIpv6.addSubnet(network, prefix, "ipv6");
}

/**
 * SSRF guard helpers: classify an IP literal as private/reserved/unsafe.
 * Shared by the MCP connector egress checks so every caller rejects the same
 * ranges. Conservative: anything unparseable or unrecognized is treated as
 * blocked.
 */
export function isPrivateIpv4(ip: string): boolean {
    if (net.isIP(ip) !== 4) return true;
    return blockedIpv4.check(ip, "ipv4");
}

/**
 * Expand an IPv6 literal (possibly using `::` compression and/or a trailing
 * dotted-quad IPv4 tail) into its eight 16-bit groups. Returns null if the
 * input is not a well-formed IPv6 literal. Any embedded dotted IPv4 tail is
 * folded into the final two hextets so callers can read the embedded address
 * uniformly.
 */
function expandIpv6Groups(ip: string): number[] | null {
    let s = ip.toLowerCase();
    const zone = s.indexOf("%");
    if (zone !== -1) s = s.slice(0, zone);

    // Fold a trailing dotted-quad IPv4 tail (e.g. `::ffff:1.2.3.4`) into two
    // hex groups so the address is a pure list of hextets.
    const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (dotted) {
        const octets = dotted.slice(1, 5).map((o) => Number.parseInt(o, 10));
        if (octets.some((o) => o > 255)) return null;
        const hi = ((octets[0] << 8) | octets[1]).toString(16);
        const lo = ((octets[2] << 8) | octets[3]).toString(16);
        s = s.slice(0, dotted.index) + `${hi}:${lo}`;
    }

    const halves = s.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

    let groups: string[];
    if (halves.length === 2) {
        const fill = 8 - head.length - tail.length;
        if (fill < 0) return null;
        groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
    } else {
        groups = head;
    }
    if (groups.length !== 8) return null;

    const nums = groups.map((g) => Number.parseInt(g || "0", 16));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) {
        return null;
    }
    return nums;
}

function embeddedIpv4(hi: number, lo: number): string {
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isPrivateIpv6(ip: string): boolean {
    const normalized = ip.toLowerCase().split("%", 1)[0];
    if (net.isIP(normalized) !== 6) return true;

    const groups = expandIpv6Groups(normalized);
    if (!groups) return true;

    // IPv4-compatible ::/96 and IPv4-mapped ::ffff:0:0/96 are not globally
    // reachable IPv6 destinations. Block the entire ranges, even when their
    // embedded IPv4 value would otherwise be public.
    if (groups.slice(0, 6).every((g) => g === 0)) {
        return true;
    }
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        return true;
    }

    // NAT64 well-known prefix 64:ff9b::/96 — last 32 bits are the target IPv4.
    // This prefix is globally reachable, so permit it only when the embedded
    // IPv4 destination is also globally reachable.
    if (
        groups[0] === 0x64 &&
        groups[1] === 0xff9b &&
        groups[2] === 0 &&
        groups[3] === 0 &&
        groups[4] === 0 &&
        groups[5] === 0
    ) {
        return isPrivateIpv4(embeddedIpv4(groups[6], groups[7]));
    }

    // Normal globally routable IPv6 unicast lives in 2000::/3. Everything
    // outside it is fail-closed, including unique-local fc00::/7, link-local
    // fe80::/10, deprecated site-local fec0::/10, multicast ff00::/8,
    // discard-only 100::/64, and local-use translation 64:ff9b:1::/48.
    const isGlobalUnicast = (groups[0] & 0xe000) === 0x2000;
    if (!isGlobalUnicast) return true;

    return blockedIpv6.check(normalized, "ipv6");
}

/**
 * True if `ip` is a private/reserved/unsafe address. Non-IP input returns true
 * (fail closed) — callers should pass resolved IP literals.
 */
export function isBlockedIp(ip: string): boolean {
    const family = net.isIP(ip);
    if (family === 4) return isPrivateIpv4(ip);
    if (family === 6) return isPrivateIpv6(ip);
    return true;
}
