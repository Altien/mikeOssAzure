export function applyDarkMode(enabled: boolean): void {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", enabled);
    document.documentElement.style.colorScheme = enabled ? "dark" : "light";
}

export function applyTransparentTables(enabled: boolean): void {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("transparent-tables", enabled);
}
