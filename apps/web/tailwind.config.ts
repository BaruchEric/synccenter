import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Map a few semantic names so usages read intent.
        idle: "#10b981",
        syncing: "#3b82f6",
        error: "#ef4444",
        conflict: "#f59e0b",
        // Instrument-panel surfaces for the activity spine. Cooler and darker
        // than slate so the amber signal reads as an indicator lamp.
        ink: "#0A0E14",
        panel: "#10161F",
        rule: "#1C2733",
        dim: "#5A6B7D",
        signal: "#E8A33D",
        ok: "#3FB950",
        fail: "#F85149",
        run: "#58A6FF",
        dry: "#8B949E",
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
