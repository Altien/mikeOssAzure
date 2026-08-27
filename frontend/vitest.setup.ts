import "@testing-library/jest-dom/vitest";

// Node >= 22.4 installs its own `localStorage` global that is undefined
// without --localstorage-file, and it shadows the one jsdom provides. Install
// an in-memory Storage so any test touching localStorage (directly or through
// a component) works regardless of the Node version running the suite. Tests
// that want to observe calls still stub their own over the top.
if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>();
    const storage: Storage = {
        get length() {
            return store.size;
        },
        key: (index: number) => [...store.keys()][index] ?? null,
        getItem: (key: string) => store.get(String(key)) ?? null,
        setItem: (key: string, value: string) => {
            store.set(String(key), String(value));
        },
        removeItem: (key: string) => {
            store.delete(String(key));
        },
        clear: () => store.clear(),
    };
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: storage,
    });
}
