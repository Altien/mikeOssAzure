// Preparing an image a person picked to be their organization's logo.
//
// The logo is shown small (18px in the sidebar), so whatever was picked is
// drawn onto a small canvas and sent as a PNG: a photograph straight off a
// phone becomes a few kilobytes, and nothing but pixels is sent — no
// metadata, and no format the server does not take.

/** The types a logo may be picked from. SVG is not one: see the server. */
export const ORG_LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

const ACCEPTED_TYPES = ORG_LOGO_ACCEPT.split(",");

/** The longest side of the stored logo, in pixels. */
export const ORG_LOGO_MAX_SIDE = 256;

/** A file too large to be worth decoding at all. */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

export class OrgLogoImageError extends Error {}

/** The size to draw at: the image's own shape, no side over the maximum. */
export function fitOrgLogo(
    width: number,
    height: number,
): { width: number; height: number } {
    const scale = Math.min(1, ORG_LOGO_MAX_SIDE / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

/**
 * Turn a picked file into the PNG data URL that is sent as the logo. Rejects
 * with an OrgLogoImageError whose message can be shown as it is.
 */
export async function prepareOrgLogo(file: File): Promise<string> {
    if (!ACCEPTED_TYPES.includes(file.type))
        throw new OrgLogoImageError("Choose a PNG, JPEG or WebP image.");
    if (file.size > MAX_SOURCE_BYTES)
        throw new OrgLogoImageError("Choose an image under 10 MB.");

    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new OrgLogoImageError("That file could not be read as an image.");
    }
    try {
        const { width, height } = fitOrgLogo(bitmap.width, bitmap.height);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context)
            throw new OrgLogoImageError("That image could not be prepared.");
        context.drawImage(bitmap, 0, 0, width, height);
        return canvas.toDataURL("image/png");
    } finally {
        bitmap.close();
    }
}
