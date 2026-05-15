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
      },
    },
  },
  plugins: [],
} satisfies Config;
