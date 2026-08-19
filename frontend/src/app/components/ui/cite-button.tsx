import React, { useState } from "react";
import { Check } from "lucide-react";
import { QuoteIcon } from "@radix-ui/react-icons";

interface CiteButtonProps {
    quoteText: string;
    quoteLabel: string;
    className?: string;
    showText?: boolean;
    iconSize?: number;
    textClassName?: string;
}

export function CiteButton({
    quoteText,
    quoteLabel,
    className = "",
    showText = true,
    iconSize = 12,
    textClassName = "text-[10px] font-medium",
}: CiteButtonProps) {
    const [isCopied, setIsCopied] = useState(false);

    const handleClick = async (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();

        try {
            const label = quoteLabel ? ` (${quoteLabel})` : "";
            const compiledText = `"${quoteText.replace(/"/g, "'")}"${label}`;
            await navigator.clipboard.writeText(compiledText);

            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch (err) {
            console.error("Failed to copy citation:", err);
        }
    };

    return (
        <button
            type="button"
            onClick={handleClick}
            // Only name the button when there is no visible label; overriding a
            // visible "Cite" with a different name breaks WCAG 2.5.3.
            aria-label={showText ? undefined : "Copy quote and citation"}
            className={`transition-colors flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 ${className}`}
            title="Copy Quote and Citation"
        >
            {isCopied ? (
                <Check
                    style={{ width: iconSize, height: iconSize }}
                    className="text-green-600"
                />
            ) : (
                <QuoteIcon style={{ width: iconSize, height: iconSize }} />
            )}
            {showText && (
                <span
                    role="status"
                    className={
                        isCopied
                            ? `text-green-600 ${textClassName}`
                            : textClassName
                    }
                >
                    {isCopied ? "Copied" : "Cite"}
                </span>
            )}
        </button>
    );
}
