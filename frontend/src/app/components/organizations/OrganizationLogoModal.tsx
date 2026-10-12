"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Modal } from "@/app/components/modals/Modal";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
  ORG_LOGO_MAX_ZOOM,
  clampOrgLogoFrame,
  initialOrgLogoFrame,
  orgLogoMinZoom,
  orgLogoPlacement,
  renderOrgLogo,
  type OrgLogoFrame,
} from "@/app/lib/orgLogoImage";

// The step between picking an image and it becoming the organization's logo.
//
// The logo is shown small and square, and most logos are neither. Here the
// person frames it — drags the picture inside a square, zooms in on the part
// that reads at a small size, or zooms out to keep all of it — and sees it at
// the size it will be in the sidebar, beside the organization's name, before
// it changes for everybody.

/** The side of the square the picture is framed in, in pixels. */
const FRAME_SIDE = 224;
/** The size the logo is drawn at in the sidebar. */
const SIDEBAR_SIDE = 18;
/** How far an arrow key moves the picture, in pixels of the square. */
const NUDGE = 8;

/** The picture as the frame shows it, in a square of any size. */
function FramedLogo({
  src,
  frame,
  side,
  className,
}: {
  src: string;
  frame: OrgLogoFrame;
  side: number;
  className?: string;
}) {
  const placement = orgLogoPlacement(frame, side);
  return (
    <span
      className={`relative block shrink-0 overflow-hidden ${className ?? ""}`}
      style={{ width: side, height: side }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the picked file */}
      <img
        src={src}
        alt=""
        draggable={false}
        className="pointer-events-none absolute max-w-none select-none"
        style={{
          left: placement.left,
          top: placement.top,
          width: placement.width,
          height: placement.height,
        }}
      />
    </span>
  );
}

export function OrganizationLogoModal({
  file,
  organizationName,
  saving = false,
  onCancel,
  onSave,
}: {
  /** The picked image, already checked for type and size. */
  file: File;
  organizationName: string;
  saving?: boolean;
  onCancel: () => void;
  /** Called with the framed logo as a PNG data URL. */
  onSave: (dataUrl: string) => void;
}) {
  // The picked file, as something an <img> can show. Made and released by
  // the same effect: React mounts effects twice in development, and a URL
  // made anywhere else would be released by the first unmount and then used
  // by the second mount, where it no longer loads.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the URL is a resource this effect owns and releases
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const imageRef = useRef<HTMLImageElement>(null);
  const [frame, setFrame] = useState<OrgLogoFrame | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const change = (next: (current: OrgLogoFrame) => OrgLogoFrame) =>
    setFrame((current) => (current ? clampOrgLogoFrame(next(current)) : null));

  /** Move the picture by a distance measured in the framing square. */
  const moveBy = (dx: number, dy: number) =>
    change((current) => {
      const { scale } = orgLogoPlacement(current, FRAME_SIDE);
      return {
        ...current,
        centerX: current.centerX - dx / scale,
        centerY: current.centerY - dy / scale,
      };
    });

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!frame || saving) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY };
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    moveBy(event.clientX - drag.current.x, event.clientY - drag.current.y);
    drag.current = { x: event.clientX, y: event.clientY };
  }
  function endDrag() {
    drag.current = null;
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // An arrow key moves the picture that way, as dragging it would.
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-NUDGE, 0],
      ArrowRight: [NUDGE, 0],
      ArrowUp: [0, -NUDGE],
      ArrowDown: [0, NUDGE],
    };
    const move = moves[event.key];
    if (!move || saving) return;
    event.preventDefault();
    moveBy(...move);
  }

  const minZoom = frame
    ? orgLogoMinZoom(frame.imageWidth, frame.imageHeight)
    : 1;

  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onCancel();
      }}
      breadcrumbs={[organizationName, "Logo"]}
      size="sm"
      className="h-auto max-h-[calc(100vh-2rem)]"
      primaryAction={{
        label: saving ? "Saving..." : "Save",
        variant: "blue",
        disabled: !frame || saving,
        onClick: () => {
          if (frame && imageRef.current)
            onSave(renderOrgLogo(imageRef.current, frame));
        },
      }}
    >
      <div
        data-modal-scroll="vertical"
        className="min-h-0 min-w-0 space-y-5 overflow-y-auto pb-4"
      >
        {unreadable ? (
          <p role="alert" className="text-sm text-red-600">
            That file could not be read as an image. Choose another.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <FieldLabel as="p">Position</FieldLabel>
              <div className="flex justify-center">
                <div
                  role="group"
                  tabIndex={0}
                  aria-label="Logo position. Drag, or use the arrow keys, to move the image."
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onKeyDown={onKeyDown}
                  className={`touch-none rounded-2xl bg-gray-100 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 ${
                    frame ? "cursor-grab active:cursor-grabbing" : ""
                  }`}
                  style={{ width: FRAME_SIDE, height: FRAME_SIDE }}
                >
                  {frame && src ? (
                    <FramedLogo
                      src={src}
                      frame={frame}
                      side={FRAME_SIDE}
                      className="rounded-2xl"
                    />
                  ) : (
                    <span className="block h-full w-full animate-pulse rounded-2xl bg-gray-200" />
                  )}
                </div>
              </div>
              {/* Never shown: it is what is measured, and what is drawn from
                  when the logo is saved. */}
              {src ? (
                // eslint-disable-next-line @next/next/no-img-element -- the picked file, read for its size and drawn onto a canvas
                <img
                  ref={imageRef}
                  src={src}
                  alt=""
                  className="hidden"
                  onLoad={(event) => {
                    const { naturalWidth, naturalHeight } =
                      event.currentTarget;
                    if (naturalWidth > 0 && naturalHeight > 0)
                      setFrame(
                        initialOrgLogoFrame(naturalWidth, naturalHeight),
                      );
                    else setUnreadable(true);
                  }}
                  onError={() => setUnreadable(true)}
                />
              ) : null}
            </div>

            <div className="space-y-2">
              <FieldLabel htmlFor="organization-logo-zoom">Zoom</FieldLabel>
              <input
                id="organization-logo-zoom"
                type="range"
                min={minZoom}
                max={ORG_LOGO_MAX_ZOOM}
                step={0.01}
                value={frame?.zoom ?? 1}
                disabled={!frame || saving}
                onChange={(event) => {
                  const zoom = Number(event.target.value);
                  change((current) => ({ ...current, zoom }));
                }}
                className="block w-full accent-blue-600 disabled:opacity-40"
              />
              <p className="text-xs text-gray-500">
                Zoom out to keep the whole image, or in on the part that
                reads best small.
              </p>
            </div>

            <div className="space-y-2">
              <FieldLabel as="p">In the sidebar</FieldLabel>
              {/* The sidebar's own heading: the mark at its size, then the
                  name in the sidebar's face. */}
              <div
                data-slot="organization-logo-preview"
                className="flex min-w-0 items-center gap-1.5 rounded-xl bg-gray-100 px-3 py-2.5"
              >
                {frame && src ? (
                  <FramedLogo
                    src={src}
                    frame={frame}
                    side={SIDEBAR_SIDE}
                    className="rounded-[3px]"
                  />
                ) : (
                  <span
                    className="block shrink-0 animate-pulse rounded-[3px] bg-gray-200"
                    style={{ width: SIDEBAR_SIDE, height: SIDEBAR_SIDE }}
                  />
                )}
                <span className="min-w-0 truncate font-serif text-xl font-light">
                  {organizationName}
                </span>
              </div>
            </div>

            <p className="text-xs text-gray-500">
              PNG, JPEG or WebP, up to 10 MB.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
