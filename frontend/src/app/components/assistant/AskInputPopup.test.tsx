import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AskInputPopup } from "./AskInputPopup";

describe("AskInputPopup", () => {
    it("submits an open-ended answer entered in a textarea", async () => {
        const onSubmit = vi.fn();
        render(
            <AskInputPopup
                event={{
                    type: "ask_inputs",
                    items: [
                        {
                            id: "registered-address",
                            kind: "text",
                            question: "What is the registered address?",
                        },
                    ],
                }}
                onSubmit={onSubmit}
            />,
        );

        const input = screen.getByRole("textbox", {
            name: "What is the registered address?",
        });
        expect(input.tagName).toBe("TEXTAREA");

        fireEvent.change(input, {
            target: { value: "1 Legal Plaza\nSingapore 048583" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toEqual({
            type: "ask_inputs_response",
            responses: [
                {
                    id: "registered-address",
                    kind: "text",
                    question: "What is the registered address?",
                    answer: "1 Legal Plaza\nSingapore 048583",
                },
            ],
        });
        expect(onSubmit.mock.calls[0][1]).toContain(
            "1 Legal Plaza\nSingapore 048583",
        );
        expect(onSubmit.mock.calls[0][2]).toEqual([]);
    });
});
