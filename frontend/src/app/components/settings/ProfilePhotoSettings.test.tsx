import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ProfilePhotoSettings } from "./ProfilePhotoSettings";

const state = vi.hoisted(() => ({ photo: null as string | null, save: vi.fn(), render: vi.fn() }));
vi.mock("@/app/contexts/AuthContext", () => ({ useAuth: () => ({ user: { email: "alex@example.com" } }) }));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: () => ({ profile: { displayName: "Alex Morgan", profilePhoto: state.photo }, updateProfilePhoto: state.save }) }));
vi.mock("@/app/lib/orgLogoImage", async (original) => ({ ...(await original<typeof import("@/app/lib/orgLogoImage")>()), renderOrgLogo: state.render }));
const PHOTO = "data:image/png;base64,iVBORw0KGgo=";
function upload(file = new File(["image"], "portrait.png", { type: "image/png" })) {
  fireEvent.change(screen.getByLabelText("Upload profile photo"), { target: { files: [file] } });
}
beforeEach(() => {
  state.photo = null;
  state.save.mockReset().mockResolvedValue(undefined);
  state.render.mockReset().mockReturnValue(PHOTO);
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 800, height: 600, close: vi.fn() }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn() } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ProfilePhotoSettings", () => {
  it("opens the circular crop and uploads only after Save", async () => {
    render(<ProfilePhotoSettings />);
    upload();
    const save = await screen.findByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    expect(screen.getByRole("group", { name: /^Photo position/ })).toHaveClass("rounded-full");
    expect(screen.getByLabelText("Zoom")).toHaveAttribute("min", "1");
    expect(state.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "2" } });
    fireEvent.click(save);
    await waitFor(() => expect(state.save).toHaveBeenCalledWith(PHOTO));
    expect(state.render.mock.lastCall![1].zoom).toBe(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("cancels without updating the account", async () => {
    render(<ProfilePhotoSettings />); upload();
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(state.save).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("rejects unsupported and oversized files", () => {
    render(<ProfilePhotoSettings />);
    upload(new File(["<svg/>"], "unsafe.svg", { type: "image/svg+xml" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a PNG, JPEG or WebP image.");
    const large = new File(["data"], "large.png", { type: "image/png" });
    Object.defineProperty(large, "size", { value: 11 * 1024 * 1024 });
    upload(large);
    expect(screen.getByRole("alert")).toHaveTextContent("under 10 MB");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps a failed save open for retry", async () => {
    state.save.mockRejectedValueOnce(new Error("internal detail"));
    render(<ProfilePhotoSettings />); upload();
    const save = await screen.findByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save your profile photo. Try again.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("removes the existing photo", async () => {
    state.photo = PHOTO;
    render(<ProfilePhotoSettings />);
    expect(screen.getByRole("button", { name: "Change photo" })).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
    expect(state.save).toHaveBeenCalledWith(null);
  });
});
