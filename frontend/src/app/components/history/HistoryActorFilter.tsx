"use client";
import { useRequestOwner } from "@/app/hooks/useRequestOwner";

import { getAuditActors, type AuditActor } from "@/app/lib/mikeApi";
import { PersonFilter } from "@/app/components/shared/PersonFilter";

/** Search and select an exact audit actor, loading additional people on scroll. */
export function HistoryActorFilter({
  orgId,
  value,
  onChange,
}: {
  orgId: string;
  value: AuditActor | null;
  onChange: (value: AuditActor | null) => void;
}) {
  const { key, capture } = useRequestOwner(orgId);
  return (
    <PersonFilter
      key={key}
      value={value}
      onChange={(person) => { if (capture()()) onChange(person); }}
      loadPeople={(query, signal) => {
        const isCurrent = capture();
        if (!isCurrent()) return Promise.reject(new Error("Request owner changed"));
        return getAuditActors({ orgId, ...query }, signal, isCurrent);
      }}
    />
  );
}
