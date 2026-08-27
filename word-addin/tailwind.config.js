/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{tsx,ts,jsx,js,html}"],
  theme: {
    extend: {
      colors: {
        // Mike brand palette — kept as a named scale (`mike-*`) so every
        // existing utility (bg-mike-500, text-mike-700, ring-mike-500) keeps
        // working, but remapped to grayscale to match the desktop's
        // black/white aesthetic. Previously this was blue (#4f6bff).
        mike: {
          50: "#f7f7f7",
          100: "#ededed",
          200: "#dddddd",
          500: "#111111",
          600: "#000000",
          700: "#000000",
          900: "#000000",
        },
      },
      fontFamily: {
        // Mirror desktop: EB Garamond for headings / display, Inter for UI.
        // Falls back to system serif so we don't ship the webfont in the
        // add-in bundle.
        serif: [
          "EB Garamond",
          "Iowan Old Style",
          "Apple Garamond",
          "Baskerville",
          "Times New Roman",
          "serif",
        ],
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
