import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { OrgLogoFrame } from "@/app/lib/orgLogoImage";
import { OrganizationLogoModal } from "./OrganizationLogoModal";

// Drawing onto a canvas needs a real browser; what is drawn — the frame the
// person arrived at — is what these pin.
const mocks = vi.hoisted(() => ({ renderOrgLogo: vi.fn() }));
vi.mock("@/app/lib/orgLogoImage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/orgLogoImage")>()),
  renderOrgLogo: mocks.renderOrgLogo,
}));

const file = new File([new Uint8Array(4)], "logo.png", { type: "image/png" });
const RENDERED = "data:image/png;base64,FRAMED";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.renderOrgLogo.mockReturnValue(RENDERED);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:picked"),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderModal(props: Partial<Parameters<typeof OrganizationLogoModal>[0]> = {}) {
  const handlers = { onCancel: vi.fn(), onSave: vi.fn() };
  const view = render(
    <OrganizationLogoModal
      file={file}
      organizationName="Acme LLP"
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view };
}

/** The browser finishing its read of the picked image, at this size. */
function loadImage(width = 800, height = 200) {
  const source = document.querySelector<HTMLImageElement>("img.hidden")!;
  Object.defineProperty(source, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(source, "naturalHeight", { value: height, configurable: true });
  fireEvent.load(source);
  return source;
}
const position = () => screen.getByRole("group", { name: /^Logo position/ });
const save = () => screen.getByRole("button", { name: "Save" });
/** The frame the logo would be saved with. */
async function savedFrame(user: ReturnType<typeof userEvent.setup>) {
  await user.click(save());
  return mocks.renderOrgLogo.mock.lastCall![1] as OrgLogoFrame;
}

describe("OrganizationLogoModal", () => {
  it("is named for the organization, and cannot save until the image has been read", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("Acme LLP").length).toBeGreaterThan(0);
    expect(save()).toBeDisabled();
    expect(screen.getByLabelText("Zoom")).toBeDisabled();
  });

  it("states the file types and the size limit", () => {
    renderModal();
    expect(
      screen.getByText("PNG, JPEG or WebP, up to 10 MB."),
    ).toBeInTheDocument();
  });

  it("starts with the picture filling the square, and saves what is framed as a PNG", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();
    const source = loadImage(800, 200);

    await user.click(save());

    expect(mocks.renderOrgLogo).toHaveBeenCalledExactlyOnceWith(source, {
      imageWidth: 800,
      imageHeight: 200,
      zoom: 1,
      centerX: 400,
      centerY: 100,
    });
    expect(onSave).toHaveBeenCalledExactlyOnceWith(RENDERED);
  });

  it("zooms out to keep the whole image, down to where it all fits and no further", async () => {
    const user = userEvent.setup();
    renderModal();
    loadImage(800, 200);
    const zoom = screen.getByLabelText("Zoom");
    // A wordmark four times as wide as tall fits whole at a quarter.
    expect(zoom).toHaveAttribute("min", "0.25");
    expect(zoom).toHaveAttribute("max", "4");

    fireEvent.change(zoom, { target: { value: "0.25" } });

    expect(await savedFrame(user)).toMatchObject({ zoom: 0.25, centerX: 400 });
  });

  it("moves the picture when it is dragged, and stops at its edge", async () => {
    const user = userEvent.setup();
    renderModal();
    loadImage(800, 200);

    // Drag the picture 56px to the left: the square is 224px across and
    // shows 200 image pixels, so that is 50 of them.
    fireEvent.pointerDown(position(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(position(), { clientX: 44, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(position(), { pointerId: 1 });
    expect((await savedFrame(user)).centerX).toBeCloseTo(450);

    // A long drag stops where the picture's edge meets the square's.
    fireEvent.pointerDown(position(), { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(position(), { clientX: -5000, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(position(), { pointerId: 1 });
    expect((await savedFrame(user)).centerX).toBe(700);
  });

  it("does not move the picture once the pointer is released", async () => {
    const user = userEvent.setup();
    renderModal();
    loadImage(800, 200);

    fireEvent.pointerDown(position(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(position(), { pointerId: 1 });
    fireEvent.pointerMove(position(), { clientX: 0, clientY: 100, pointerId: 1 });

    expect((await savedFrame(user)).centerX).toBe(400);
  });

  it("moves the picture with the arrow keys, for somebody not using a pointer", async () => {
    const user = userEvent.setup();
    renderModal();
    loadImage(800, 200);

    position().focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");

    // Moving the picture right shows what is to its left.
    expect((await savedFrame(user)).centerX).toBeLessThan(400);
  });

  it("previews the logo at the size it has in the sidebar, beside the organization's name", () => {
    renderModal();
    loadImage(800, 200);

    const preview = document.querySelector<HTMLElement>(
      '[data-slot="organization-logo-preview"]',
    )!;
    expect(within(preview).getByText("Acme LLP")).toBeInTheDocument();
    const mark = preview.querySelector<HTMLElement>("span.overflow-hidden")!;
    expect(mark.style.width).toBe("18px");
    expect(mark.style.height).toBe("18px");
    // The same picture, placed the same way, only smaller.
    const image = mark.querySelector("img")!;
    expect(image).toHaveAttribute("src", "blob:picked");
    expect(image.style.width).toBe("72px");
    expect(image.style.height).toBe("18px");
  });

  it("says so when the file is not really an image, and offers nothing to save", () => {
    renderModal();
    fireEvent.error(document.querySelector("img.hidden")!);

    expect(
      screen.getByText("That file could not be read as an image. Choose another."),
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(screen.queryByLabelText("Zoom")).not.toBeInTheDocument();
  });

  it("can be cancelled, but not while the logo is being saved", async () => {
    const user = userEvent.setup();
    const { onCancel, rerender, onSave } = renderModal();
    loadImage();

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <OrganizationLogoModal
        file={file}
        organizationName="Acme LLP"
        saving
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
  });

  it("still shows the image when React mounts it twice, as it does in development", () => {
    // The preview URL was made once and released by the first unmount, so
    // the second mount was left holding a URL that no longer loaded and
    // every picked image was reported as unreadable.
    let made = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:picked-${++made}`);
    render(
      <StrictMode>
        <OrganizationLogoModal
          file={file}
          organizationName="Acme LLP"
          onCancel={vi.fn()}
          onSave={vi.fn()}
        />
      </StrictMode>,
    );

    const shown = document.querySelector<HTMLImageElement>("img.hidden")!;
    const released = vi
      .mocked(URL.revokeObjectURL)
      .mock.calls.map(([url]) => url);
    // Whatever was released, it is not the one being shown.
    expect(released).not.toContain(shown.getAttribute("src"));
    expect(shown.getAttribute("src")).toBe(`blob:picked-${made}`);
  });

  it("releases the picked file's preview when it closes", () => {
    const { unmount } = renderModal();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:picked");
  });
});
