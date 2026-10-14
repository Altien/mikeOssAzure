"use client";

import { ImageCropModal } from "@/app/components/modals/ImageCropModal";

export function OrganizationLogoModal({ organizationName, ...props }: {
  file: File;
  organizationName: string;
  saving?: boolean;
  onCancel: () => void;
  onSave: (dataUrl: string) => void;
}) {
  return <ImageCropModal {...props} name={organizationName} />;
}
