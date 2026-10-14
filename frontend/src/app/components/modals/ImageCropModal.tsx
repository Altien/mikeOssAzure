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
  validateOrgLogoFile,
  type OrgLogoFrame,
} from "@/app/lib/orgLogoImage";

// Shared image framing for organization logos and user profile photos.
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
  image,
  frame,
  side,
  className,
}: {
  image: ImageBitmap;
  frame: OrgLogoFrame;
  side: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(side * ratio);
    canvas.height = Math.round(side * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, side, side);
    context.imageSmoothingQuality = "high";
    const placement = orgLogoPlacement(frame, side);
    context.drawImage(image, placement.left, placement.top, placement.width, placement.height);
  }, [frame, image, side]);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none block shrink-0 ${className ?? ""}`}
      style={{ width: side, height: side }}
    />
  );
}

export function ImageCropModal({
  file,
  name,
  variant = "logo",
  saving = false,
  error,
  onCancel,
  onSave,
}: {
  /** The picked image, already checked for type and size. */
  file: File;
  name: string;
  variant?: "logo" | "photo";
  saving?: boolean;
  error?: string | null;
  onCancel: () => void;
  /** Called with the framed logo as a PNG data URL. */
  onSave: (dataUrl: string) => void;
}) {
  // Decode the upload into pixels before displaying it. The raw file never
  // becomes a DOM URL, so markup cannot be interpreted as preview content.
  const [loaded, setLoaded] = useState<{
    file: File;
    image: ImageBitmap;
    frame: OrgLogoFrame;
  } | null>(null);
  const [failedFile, setFailedFile] = useState<File | null>(null);
  useEffect(() => {
    let cancelled = false;
    let bitmap: ImageBitmap | undefined;
    async function decode() {
      try {
        validateOrgLogoFile(file);
        const image = await createImageBitmap(file);
        if (cancelled) {
          image.close();
          return;
        }
        bitmap = image;
        if (image.width <= 0 || image.height <= 0) {
          image.close();
          bitmap = undefined;
          setFailedFile(file);
          return;
        }
        setLoaded({ file, image, frame: initialOrgLogoFrame(image.width, image.height) });
      } catch {
        if (!cancelled) setFailedFile(file);
      }
    }
    void decode();
    return () => {
      cancelled = true;
      bitmap?.close();
    };
  }, [file]);

  const isPhoto = variant === "photo";
  const previewSide = isPhoto ? 20 : SIDEBAR_SIDE;
  const [saveError, setSaveError] = useState(false);
  const image = loaded?.file === file ? loaded.image : null;
  const frame = loaded?.file === file ? loaded.frame : null;
  const unreadable = failedFile === file;
  const drag = useRef<{ x: number; y: number } | null>(null);

  const change = (next: (current: OrgLogoFrame) => OrgLogoFrame) =>
    setLoaded((current) => {
      if (current?.file !== file) return current;
      const frame = next(current.frame);
      return { ...current, frame: clampOrgLogoFrame({
        ...frame, zoom: Math.max(isPhoto ? 1 : 0, frame.zoom),
      }) };
    });

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
    if (!drag.current || saving) return;
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
    ? isPhoto ? 1 : orgLogoMinZoom(frame.imageWidth, frame.imageHeight)
    : 1;

  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onCancel();
      }}
      breadcrumbs={[isPhoto ? "Account" : name, isPhoto ? "Profile photo" : "Logo"]}
      size="sm"
      className="h-auto max-h-[calc(100vh-2rem)]"
      primaryAction={{
        label: saving ? "Saving..." : "Save",
        variant: "blue",
        disabled: !frame || saving,
        onClick: () => {
          if (!frame || !image) return;
          try {
            setSaveError(false);
            onSave(renderOrgLogo(image, frame));
          } catch {
            setSaveError(true);
          }
        },
      }}
    >
      <div
        data-modal-scroll="vertical"
        className="min-h-0 min-w-0 space-y-5 overflow-y-auto pb-4"
      >
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
        {saveError ? <p role="alert" className="text-sm text-red-600">That image could not be prepared. Choose another.</p> : null}
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
                  aria-label={`${isPhoto ? "Photo" : "Logo"} position. Drag, or use the arrow keys, to move the image.`}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onKeyDown={onKeyDown}
                  className={`touch-none ${isPhoto ? "rounded-full" : "rounded-2xl"} bg-gray-100 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 ${
                    frame ? "cursor-grab active:cursor-grabbing" : ""
                  }`}
                  style={{ width: FRAME_SIDE, height: FRAME_SIDE }}
                >
                  {frame && image ? (
                    <FramedLogo
                      image={image}
                      frame={frame}
                      side={FRAME_SIDE}
                      className={isPhoto ? "rounded-full" : "rounded-2xl"}
                    />
                  ) : (
                    <span className="block h-full w-full animate-pulse rounded-2xl bg-gray-200" />
                  )}
                </div>
              </div>
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
                {isPhoto ? "Drag to position your photo and zoom to frame your face." : "Zoom out to keep the whole image, or in on the part that reads best small."}
              </p>
            </div>

            <div className="space-y-2">
              <FieldLabel as="p">{isPhoto ? "Preview" : "In the sidebar"}</FieldLabel>
              {/* The sidebar's own heading: the mark at its size, then the
                  name in the sidebar's face. */}
              <div
                data-slot={isPhoto ? "profile-photo-preview" : "organization-logo-preview"}
                className="flex min-w-0 items-center gap-1.5 rounded-xl bg-gray-100 px-3 py-2.5"
              >
                {frame && image ? (
                  <FramedLogo
                    image={image}
                    frame={frame}
                    side={previewSide}
                    className={isPhoto ? "rounded-full" : "rounded-[3px]"}
                  />
                ) : (
                  <span
                    className="block shrink-0 animate-pulse rounded-[3px] bg-gray-200"
                    style={{ width: previewSide, height: previewSide }}
                  />
                )}
                <span className={isPhoto ? "min-w-0 text-sm [overflow-wrap:anywhere]" : "min-w-0 truncate font-serif text-xl font-light"}>
                  {name}
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
