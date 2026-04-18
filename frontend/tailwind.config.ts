import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./hooks/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        risk: {
          low:    "#22c55e",  // Green
          medium: "#f59e0b",  // Amber
          high:   "#ef4444",  // Red
          critical: "#dc2626",
        },
        surface: {
          900: "#0a0a0f",
          800: "#12121a",
          700: "#1a1a26",
          600: "#252533",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      animation: {
        "pulse-risk": "pulse-risk 2s ease-in-out infinite",
      },
      keyframes: {
        "pulse-risk": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
