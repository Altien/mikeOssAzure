export function logRawLlmStream(args: {
    provider: string;
    model: string;
    iteration: number;
    label: string;
    payload: unknown;
}) {
    if (
        process.env.NODE_ENV === "production" &&
        process.env.LOG_RAW_LLM_STREAM !== "true"
    ) {
        return;
    }

    console.log(
        `[raw-llm-stream:${args.provider}:${args.model}:iter-${args.iteration}] ${args.label}`,
    );
    console.dir(args.payload, { depth: null, maxArrayLength: null });
}
