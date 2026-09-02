"use client";

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    getHelpArticle,
    listHelpArticles,
    type HelpArticle,
    type HelpArticleSummary,
} from "@/app/lib/mikeApi";
import { cn } from "@/lib/utils";

// Styling mirrors the assistant's markdown rendering rather than pulling in a
// typography plugin for one page.
const MARKDOWN_COMPONENTS = {
    h1: (props: object) => (
        <h1 className="mb-4 font-serif text-3xl font-semibold" {...props} />
    ),
    h2: (props: object) => (
        <h2 className="mt-8 mb-3 font-serif text-2xl font-semibold" {...props} />
    ),
    h3: (props: object) => (
        <h3 className="mt-6 mb-2 text-xl font-semibold" {...props} />
    ),
    p: (props: object) => <p className="my-3 leading-7" {...props} />,
    ul: (props: object) => (
        <ul className="my-3 list-disc space-y-1 pl-6" {...props} />
    ),
    ol: (props: object) => (
        <ol className="my-3 list-decimal space-y-1 pl-6" {...props} />
    ),
    strong: (props: object) => (
        <strong className="font-semibold text-slate-900" {...props} />
    ),
    code: (props: object) => (
        <code
            className="rounded bg-slate-200 px-1 py-0.5 text-[13px]"
            {...props}
        />
    ),
    table: (props: object) => (
        <div className="my-4 overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-300" {...props} />
        </div>
    ),
    thead: (props: object) => <thead className="bg-slate-100" {...props} />,
    tbody: (props: object) => (
        <tbody className="divide-y divide-slate-200" {...props} />
    ),
    th: (props: object) => (
        <th
            className="px-3 py-2 text-left text-sm font-semibold text-slate-900"
            {...props}
        />
    ),
    td: (props: object) => (
        <td className="px-3 py-2 align-top text-sm" {...props} />
    ),
};

export default function HelpPage() {
    const [articles, setArticles] = useState<HelpArticleSummary[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [article, setArticle] = useState<HelpArticle | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const found = await listHelpArticles();
                if (cancelled) return;
                setArticles(found);
                // Deep links (/help#authority-trace) open that guide; otherwise
                // the first one, so the page is never an empty shell.
                const wanted = window.location.hash.replace(/^#/, "");
                const initial =
                    found.find((entry) => entry.slug === wanted)?.slug ??
                    found[0]?.slug ??
                    null;
                setSelected(initial);
            } catch (reason) {
                if (!cancelled) {
                    setError(
                        reason instanceof Error
                            ? reason.message
                            : "Failed to load help",
                    );
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const loadArticle = useCallback(async (slug: string) => {
        setError(null);
        try {
            setArticle(await getHelpArticle(slug));
        } catch (reason) {
            setArticle(null);
            setError(
                reason instanceof Error
                    ? reason.message
                    : "Failed to load this guide",
            );
        }
    }, []);

    useEffect(() => {
        if (selected) void loadArticle(selected);
    }, [selected, loadArticle]);

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
                Loading help…
            </div>
        );
    }

    if (articles.length === 0) {
        return (
            <div className="p-6 text-sm text-slate-500">
                No guides are bundled with this installation.
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0">
            <nav
                aria-label="Help contents"
                className="w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3"
            >
                <h2 className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Contents
                </h2>
                {articles.map((entry) => (
                    <button
                        key={entry.slug}
                        type="button"
                        onClick={() => {
                            setSelected(entry.slug);
                            window.history.replaceState(
                                null,
                                "",
                                `#${entry.slug}`,
                            );
                        }}
                        aria-current={
                            entry.slug === selected ? "page" : undefined
                        }
                        className={cn(
                            "mb-1 w-full rounded-md px-2 py-1.5 text-left text-sm",
                            entry.slug === selected
                                ? "bg-blue-50 font-medium text-blue-800"
                                : "text-slate-700 hover:bg-slate-50",
                        )}
                    >
                        {entry.title}
                    </button>
                ))}
            </nav>

            <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-6">
                {error ? (
                    <p className="text-sm text-red-700" role="alert">
                        {error}
                    </p>
                ) : article ? (
                    <article className="mx-auto max-w-3xl text-slate-800">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={MARKDOWN_COMPONENTS}
                        >
                            {article.markdown}
                        </ReactMarkdown>
                    </article>
                ) : null}
            </main>
        </div>
    );
}
