"use client";

import {
  PersonalisationFields,
  type PersonalisationField,
  type PersonalisationFieldsState,
} from "./PersonalisationFields";
import { SettingsRow } from "./SettingsRow";

export function SettingsPersonalisationFields({
  form,
  statusFor,
  practiceAreasAriaLabel,
}: {
  form: PersonalisationFieldsState;
  statusFor?: (field: PersonalisationField) => string | null;
  practiceAreasAriaLabel?: string;
}) {
  return (
    <PersonalisationFields
      form={form}
      statusFor={statusFor}
      practiceAreasAriaLabel={practiceAreasAriaLabel}
      renderGroup={(_, content) => (
        <SettingsRow layout="stacked">{content}</SettingsRow>
      )}
    />
  );
}
