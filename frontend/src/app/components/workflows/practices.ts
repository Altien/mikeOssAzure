import { PRACTICE_AREA_OPTIONS } from "@/app/onboarding/options";

export const PRACTICE_OPTIONS = [
    "General Transactions",
    ...PRACTICE_AREA_OPTIONS,
] as const;

export type Practice = (typeof PRACTICE_OPTIONS)[number];
