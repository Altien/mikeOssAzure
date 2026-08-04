import { describe, expect, it } from "vitest";
import { isBlockedIp, isPrivateIpv4, isPrivateIpv6 } from "../privateIp";

describe("private/reserved IP classification", () => {
    it.each([
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.0.0.1",
        "192.0.2.1",
        "192.88.99.1",
        "192.168.0.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
    ])("blocks non-global IPv4 address %s", (ip) => {
        expect(isPrivateIpv4(ip)).toBe(true);
        expect(isBlockedIp(ip)).toBe(true);
    });

    it.each(["8.8.8.8", "93.184.216.34", "192.31.196.1"])(
        "allows globally reachable IPv4 address %s",
        (ip) => {
            expect(isPrivateIpv4(ip)).toBe(false);
            expect(isBlockedIp(ip)).toBe(false);
        },
    );

    it.each([
        "::",
        "::1",
        "::ffff:8.8.8.8",
        "::8.8.8.8",
        "100::1",
        "2001::1",
        "2001:2::1",
        "2001:10::1",
        "2001:db8::1",
        "2002::1",
        "3fff::1",
        "5f00::1",
        "fc00::1",
        "fd00::1",
        "fe80::1",
        "fec0::1",
        "ff02::1",
        "64:ff9b::10.0.0.1",
        "64:ff9b:1::1",
    ])("blocks non-global IPv6 address %s", (ip) => {
        expect(isPrivateIpv6(ip)).toBe(true);
        expect(isBlockedIp(ip)).toBe(true);
    });

    it.each([
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
        "64:ff9b::8.8.8.8",
    ])("allows globally reachable IPv6 address %s", (ip) => {
        expect(isPrivateIpv6(ip)).toBe(false);
        expect(isBlockedIp(ip)).toBe(false);
    });

    it.each(["1foo.2.3.4", "999.1.1.1", "not-an-ip"])(
        "fails closed for malformed address %s",
        (ip) => {
            expect(isPrivateIpv4(ip)).toBe(true);
            expect(isBlockedIp(ip)).toBe(true);
        },
    );
});
