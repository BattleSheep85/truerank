// Frank production Tailwind v3 build config (no package manager).
// Build with the standalone tailwindcss binary (see README "Build CSS"):
//   ./tailwindcss -c tailwind.config.cjs -i build/input.css -o public/css/tailwind.css --minify
// Colors alias CSS variables (defined in public/css/app.css) via color-mix so a
// single `.dark` class flips every token and alpha modifiers (e.g. /60) work.
// Tailwind calls this with `opacityValue` set to:
//   - undefined            → base utility, no /alpha modifier
//   - a number in (0,1]    → an explicit /NN modifier (e.g. bg-bg/60)
//   - a CSS var string      → the `--tw-bg-opacity` placeholder Tailwind injects
//     for base color utilities. Multiplying that string by 100 yields `NaN%`,
//     which makes the whole color-mix() invalid and silently drops the color —
//     the bug that left every token-backed utility unstyled (white in dark mode).
// Only emit color-mix() for a real numeric alpha < 1; otherwise use the var as-is.
const alpha = (name) => ({ opacityValue }) => {
  const n = Number(opacityValue);
  return Number.isFinite(n) && n < 1
    ? `color-mix(in srgb, var(${name}) ${n * 100}%, transparent)`
    : `var(${name})`;
};

module.exports = {
  darkMode: 'class',
  content: ['./public/**/*.html', './public/**/*.js', './worker/**/*.js'],
  theme: {
    extend: {
      colors: {
        bg: alpha('--bg'),
        'surface-1': alpha('--surface-1'),
        'surface-2': alpha('--surface-2'),
        'surface-3': alpha('--surface-3'),
        line: alpha('--line'),
        'line-strong': alpha('--line-strong'),
        ink: alpha('--ink'),
        'ink-2': alpha('--ink-2'),
        'ink-3': alpha('--ink-3'),
        accent: {
          DEFAULT: alpha('--accent'),
          hover: alpha('--accent-hover'),
          strong: alpha('--accent-strong'),
          quiet: alpha('--accent-quiet'),
        },
        'trust-high': alpha('--trust-high'),
        'trust-high-bg': alpha('--trust-high-bg'),
        'trust-medium': alpha('--trust-medium'),
        'trust-medium-bg': alpha('--trust-medium-bg'),
        'trust-low': alpha('--trust-low'),
        'trust-low-bg': alpha('--trust-low-bg'),
      },
      fontFamily: {
        serif: ['Newsreader', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        overline: ['0.75rem', { lineHeight: '1.4', letterSpacing: '0.12em' }],
        caption: ['0.8125rem', { lineHeight: '1.5' }],
        'body-sm': ['0.9375rem', { lineHeight: '1.6' }],
        body: ['1.0625rem', { lineHeight: '1.7' }],
        'mono-data': ['0.875rem', { lineHeight: '1.4' }],
        lead: ['1.25rem', { lineHeight: '1.6' }],
        h3: ['1.375rem', { lineHeight: '1.3', letterSpacing: '-0.01em' }],
        h2: ['1.875rem', { lineHeight: '1.2', letterSpacing: '-0.01em' }],
        h1: ['2.5rem', { lineHeight: '1.1', letterSpacing: '-0.02em' }],
        display: ['3.5rem', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
      },
      borderRadius: {
        sm: '0.375rem',
        DEFAULT: '0.625rem',
        lg: '0.875rem',
        xl: '1.125rem',
        '2xl': '1.5rem',
      },
      boxShadow: {
        xs: 'var(--xs)',
        card: 'var(--card)',
        lift: 'var(--lift)',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
      },
      animation: {
        'fade-in': 'fade-in 0.4s ease both',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
};
