"use client";

import { ImageCropModal } from "@/app/components/modals/ImageCropModal";

/** Adapts the shared crop modal to organization-logo naming and its square framing variant. */
export function OrganizationLogoModal({ organizationName, ...props }: {
  file: File;
  organizationName: string;
  saving?: boolean;
  onCancel: () => void;
  onSave: (dataUrl: string) => void;
}) {
  return <ImageCropModal {...props} name={organizationName} />;
}
