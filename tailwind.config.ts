import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        /**
         * Blueprint palette, resolved through CSS variables so one `data-theme`
         * attribute flips the whole app. Values live in app/globals.css as
         * space-separated RGB channels — that form is what lets Tailwind keep
         * applying its own alpha (`border-pv-border/25`) on top of a variable.
         *
         * Legacy token names (cyan/fuch/emerald) stay so existing utility classes
         * keep working; they all resolve to the one blueprint blue.
         */
        pv: {
          bg:       "rgb(var(--pv-bg) / <alpha-value>)",
          surface:  "rgb(var(--pv-surface) / <alpha-value>)",
          surface2: "rgb(var(--pv-surface2) / <alpha-value>)",
          border:   "rgb(var(--pv-border) / <alpha-value>)",
          text:     "rgb(var(--pv-text) / <alpha-value>)",
          muted:    "rgb(var(--pv-muted) / <alpha-value>)",
          /**
           * Hairlines and tinted panels. Was a literal `white/[0.08]` in 418
           * places, which is invisible on a light background; as a token it
           * inverts to navy with the theme.
           */
          ink:      "rgb(var(--pv-ink) / <alpha-value>)",
          cyan:     "rgb(var(--pv-accent) / <alpha-value>)",
          fuch:     "rgb(var(--pv-accent) / <alpha-value>)",
          emerald:  "rgb(var(--pv-accent) / <alpha-value>)",
          gold:     "rgb(var(--pv-gold) / <alpha-value>)",
          danger:   "rgb(var(--pv-danger) / <alpha-value>)",
        },
      },
      fontFamily: {
        display: ["'Maple Mono'", "var(--font-display)", "ui-monospace", "monospace"],
        body:    ["'Maple Mono'", "var(--font-body)",    "ui-monospace", "monospace"],
        mono:    ["'Maple Mono'", "var(--font-mono)",    "ui-monospace", "monospace"],
      },
      // Blueprint look: sharp corners everywhere. Pills/dots/avatars keep
      // their roundness via `rounded-full`.
      borderRadius: {
        DEFAULT: "0px",
        none:  "0px",
        sm:    "0px",
        md:    "0px",
        lg:    "0px",
        xl:    "0px",
        "2xl": "0px",
        "3xl": "0px",
        "4xl": "0px",
        full:  "9999px",
      },
      boxShadow: {
        glow:           "0 0 40px rgba(51,79,169,0.3)",
        "glow-fuch":    "0 0 40px rgba(51,79,169,0.26)",
        "glow-emerald": "0 0 40px rgba(51,79,169,0.2)",
        "glow-gold":    "0 0 40px rgba(224,179,106,0.16)",
        "glow-lg":      "0 0 60px rgba(51,79,169,0.34)",
        "glow-fuch-lg": "0 0 60px rgba(51,79,169,0.3)",
        "glow-emerald-lg": "0 0 60px rgba(51,79,169,0.24)",
      },
      keyframes: {
        fadeUp: {
          from: { opacity: "0", transform: "translateY(18px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          from: { opacity: "0" },
          to:   { opacity: "1" },
        },
        stampIn: {
          "0%":   { opacity: "0", transform: "scale(2.5) rotate(-12deg)" },
          "50%":  { opacity: "1", transform: "scale(0.95) rotate(-12deg)" },
          "100%": { opacity: "1", transform: "scale(1) rotate(-12deg)" },
        },
        confDrop: {
          "0%":   { opacity: "1", transform: "translateY(0) rotate(0deg)" },
          "100%": { opacity: "0", transform: "translateY(100vh) rotate(600deg)" },
        },
        pulseGlow: {
          "0%, 100%": { boxShadow: "0 0 20px rgba(78,222,163,0.06)" },
          "50%":      { boxShadow: "0 0 50px rgba(78,222,163,0.18)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%":      { opacity: "0" },
        },
        countRoll: {
          from: { opacity: "0", transform: "translateY(12px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%":      { transform: "translateY(-6px)" },
        },
        "spin-slow": {
          to: { transform: "rotate(360deg)" },
        },
        /* ── Ritual system ── */
        fuseDecay: {
          "0%":   { backgroundPosition: "0% 50%" },
          "100%": { backgroundPosition: "200% 50%" },
        },
        phaseGlow: {
          "0%, 100%": { opacity: "0.4" },
          "50%":      { opacity: "1" },
        },
        tensionPulse: {
          "0%, 100%": { opacity: "0.2", transform: "scaleY(0.95)" },
          "50%":      { opacity: "0.6", transform: "scaleY(1)" },
        },
        sealFlash: {
          "0%":   { opacity: "0", transform: "scale(1.8) rotate(-8deg)" },
          "40%":  { opacity: "1", transform: "scale(0.96) rotate(-8deg)" },
          "100%": { opacity: "1", transform: "scale(1) rotate(-8deg)" },
        },
        tickDown: {
          "0%":   { opacity: "0", transform: "translateY(-8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-up":    "fadeUp 0.5s ease-out both",
        "fade-in":    "fadeIn 0.3s ease-out both",
        "stamp-in":   "stampIn 0.6s ease-out both",
        "conf-drop":  "confDrop 2s ease-in forwards",
        "pulse-glow": "pulseGlow 3s ease-in-out infinite",
        blink:        "blink 1s step-end infinite",
        "count-roll": "countRoll 0.4s ease-out both",
        shimmer:      "shimmer 2s linear infinite",
        float:        "float 3s ease-in-out infinite",
        "spin-slow":  "spin-slow 8s linear infinite",
        /* ── Ritual system ── */
        "fuse-decay":     "fuseDecay 2s linear infinite",
        "phase-glow":     "phaseGlow 2s ease-in-out infinite",
        "tension-pulse":  "tensionPulse 2.5s ease-in-out infinite",
        "seal-flash":     "sealFlash 0.55s ease-out both",
        "tick-down":      "tickDown 0.25s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
