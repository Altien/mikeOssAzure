"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { authInputClassName } from "@/app/components/auth/authStyles";
import {
  Dropdown,
  DropdownContent,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  RESPONSE_STYLE_OPTIONS,
  getResponseStyle,
  updateResponseStyle,
  type ResponseStyle,
  type ResponseStyleField,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";

type OptionCopy = { label: string; description: string };

// Typed per field, so adding an option to RESPONSE_STYLE_OPTIONS without its
// copy here fails the typecheck.
const SETTINGS: {
  [Field in ResponseStyleField]: {
    label: string;
    options: Record<ResponseStyle[Field], OptionCopy>;
  };
} = {
  verbosity: {
    label: "Verbosity",
    options: {
      concise: {
        label: "Concise",
        description: "Short, direct answers that lead with the conclusion.",
      },
      balanced: {
        label: "Balanced",
        description: "Enough explanation to follow the reasoning.",
      },
      detailed: {
        label: "Detailed",
        description: "Fuller reasoning, exceptions, and practical next steps.",
      },
    },
  },
  formatting: {
    label: "Headers and Lists",
    options: {
      balanced: {
        label: "Balanced",
        description: "Mike picks the layout that suits each answer.",
      },
      less: {
        label: "Less",
        description: "Mostly prose, with headings and lists only when needed.",
      },
      more: {
        label: "More",
        description: "Headings, bullet points, and tables for easy scanning.",
      },
    },
  },
  tone: {
    label: "Tone",
    options: {
      formal: {
        label: "Formal and Legal",
        description: "A precise, client-ready legal register.",
      },
      balanced: {
        label: "Balanced",
        description: "Mike's usual professional tone.",
      },
      plain: {
        label: "Plain and Simple",
        description:
          "Short sentences and everyday words, with legal terms explained.",
      },
    },
  },
};

const FIELDS = Object.keys(RESPONSE_STYLE_OPTIONS) as ResponseStyleField[];

export function ResponseStyleSection() {
  const [style, setStyle] = useState<ResponseStyle | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [saveErrors, setSaveErrors] = useState<
    Partial<Record<ResponseStyleField, string>>
  >({});
  // Per setting, only the newest choice may settle the UI; an older save
  // that resolves late must not overwrite it.
  const latestRequestRef = useRef<Record<ResponseStyleField, number>>({
    verbosity: 0,
    formatting: 0,
    tone: 0,
  });

  useEffect(() => {
    const controller = new AbortController();
    getResponseStyle(controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setStyle(loaded);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, [loadVersion]);

  const choose = async <Field extends ResponseStyleField>(
    field: Field,
    next: ResponseStyle[Field],
  ) => {
    if (!style || style[field] === next) return;
    const previous = style[field];
    const request = ++latestRequestRef.current[field];
    const settle = (value: ResponseStyle[Field]) =>
      setStyle((current) => (current ? { ...current, [field]: value } : current));
    settle(next);
    setSaveErrors((current) => ({ ...current, [field]: undefined }));
    try {
      const saved = await updateResponseStyle({ [field]: next });
      if (request !== latestRequestRef.current[field]) return;
      settle(saved[field]);
    } catch (error) {
      if (request !== latestRequestRef.current[field]) return;
      settle(previous);
      setSaveErrors((current) => ({
        ...current,
        [field]: userFacingApiError(
          error,
          "This setting could not be saved. Please try again.",
        ),
      }));
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="response-style-heading">
      <SettingsHeading id="response-style-heading">Response style</SettingsHeading>
      <SettingsDescription>
        Choose how Mike shapes its answers in chats.
      </SettingsDescription>
      <SettingsCard>
        {loadError ? (
          <SettingsRow>
            <p className="text-sm text-red-600" role="alert">
              Could not load your response style.
            </p>
            <PillButtonUI
              tone="white"
              size="sm"
              onClick={() => {
                setLoadError(false);
                setLoadVersion((current) => current + 1);
              }}
            >
              Retry
            </PillButtonUI>
          </SettingsRow>
        ) : (
          FIELDS.map((field) => (
            <StyleSettingRow
              key={field}
              id={`response-${field}`}
              label={SETTINGS[field].label}
              options={RESPONSE_STYLE_OPTIONS[field].map((option) => ({
                value: option,
                ...(SETTINGS[field].options as Record<string, OptionCopy>)[
                  option
                ],
              }))}
              value={style ? style[field] : null}
              error={saveErrors[field] ?? null}
              onChange={(next) =>
                void choose(field, next as ResponseStyle[typeof field])
              }
            />
          ))
        )}
      </SettingsCard>
    </section>
  );
}

function StyleSettingRow({
  id,
  label,
  options,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  options: ({ value: string } & OptionCopy)[];
  value: string | null;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <SettingsRow>
      <div className="min-w-0 space-y-1">
        <SettingsLabel>{label}</SettingsLabel>
        {selected ? (
          <SettingsDescription>{selected.description}</SettingsDescription>
        ) : (
          <div
            className="h-5 w-56 max-w-full animate-pulse rounded bg-app-surface"
            aria-hidden="true"
          />
        )}
        {error && (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
      </div>
      <Dropdown>
        <DropdownTrigger asChild>
          <button
            id={id}
            type="button"
            aria-label={label}
            disabled={!selected}
            aria-busy={!selected}
            className={cn(
              "flex h-9 w-full shrink-0 items-center justify-between gap-2 text-left text-sm outline-none disabled:cursor-default disabled:opacity-60 sm:w-44",
              authInputClassName,
            )}
          >
            <span className="truncate">{selected?.label ?? "Loading..."}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
          </button>
        </DropdownTrigger>
        <DropdownContent
          align="end"
          sideOffset={6}
          className="w-[var(--radix-dropdown-menu-trigger-width)]"
        >
          <DropdownRadioGroup value={value ?? ""} onValueChange={onChange}>
            {options.map((option) => (
              <DropdownRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownRadioItem>
            ))}
          </DropdownRadioGroup>
        </DropdownContent>
      </Dropdown>
    </SettingsRow>
  );
}
