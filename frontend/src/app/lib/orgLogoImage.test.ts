import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ORG_LOGO_MAX_SIDE,
    OrgLogoImageError,
    fitOrgLogo,
    prepareOrgLogo,
} from "./orgLogoImage";

const file = (type: string, size = 10) =>
    new File([new Uint8Array(size)], "logo", { type });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("fitOrgLogo", () => {
    it("keeps a small image as it is", () => {
        expect(fitOrgLogo(120, 80)).toEqual({ width: 120, height: 80 });
    });

    it("scales a large image down to the longest side allowed, keeping its shape", () => {
        expect(fitOrgLogo(1024, 512)).toEqual({
            width: ORG_LOGO_MAX_SIDE,
            height: ORG_LOGO_MAX_SIDE / 2,
        });
        expect(fitOrgLogo(600, 2400)).toEqual({
            width: ORG_LOGO_MAX_SIDE / 4,
            height: ORG_LOGO_MAX_SIDE,
        });
    });

    it("never rounds a thin image away to nothing", () => {
        expect(fitOrgLogo(4000, 3).height).toBe(1);
    });
});

describe("prepareOrgLogo", () => {
    it.each(["image/svg+xml", "image/gif", "application/pdf", ""])(
        "refuses %p before reading it",
        async (type) => {
            const decode = vi.fn();
            vi.stubGlobal("createImageBitmap", decode);
            await expect(prepareOrgLogo(file(type))).rejects.toThrow(
                "Choose a PNG, JPEG or WebP image.",
            );
            expect(decode).not.toHaveBeenCalled();
        },
    );

    it("refuses a file too large to be worth decoding", async () => {
        const huge = file("image/png");
        Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
        await expect(prepareOrgLogo(huge)).rejects.toBeInstanceOf(
            OrgLogoImageError,
        );
    });

    it("says so when the file is not really an image", async () => {
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn().mockRejectedValue(new Error("decode failed")),
        );
        await expect(prepareOrgLogo(file("image/png"))).rejects.toThrow(
            "That file could not be read as an image.",
        );
    });

    it("draws the image at its fitted size and sends it as a PNG", async () => {
        const close = vi.fn();
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn().mockResolvedValue({ width: 1024, height: 512, close }),
        );
        const drawImage = vi.fn();
        const canvas = {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage }),
            toDataURL: vi.fn(() => "data:image/png;base64,AAAA"),
        };
        vi.spyOn(document, "createElement").mockReturnValue(canvas as never);

        await expect(prepareOrgLogo(file("image/jpeg"))).resolves.toBe(
            "data:image/png;base64,AAAA",
        );
        expect([canvas.width, canvas.height]).toEqual([256, 128]);
        expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 256, 128);
        expect(canvas.toDataURL).toHaveBeenCalledWith("image/png");
        // The decoded image is released whatever happens.
        expect(close).toHaveBeenCalledTimes(1);
    });
});
