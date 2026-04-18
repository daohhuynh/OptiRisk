import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './hooks/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Chakra Petch', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        terminal: {
          bg: '#040810',
          surface: '#0a1628',
          'surface-2': '#0f2040',
          border: 'rgba(0,200,255,0.15)',
          text: '#c8e6f5',
          muted: '#4a7a9b',
          accent: '#00e5ff',
        },
        risk: {
          idle: '#1a3a5c',
          stressed: '#ff8c00',
          critical: '#ff5000',
          defaulted: '#ff2020',
          hero: '#a855f7',
        },
      },
      animation: {
        'pulse-risk': 'pulse-risk 1s ease-in-out infinite',
        'scan-line': 'scan-line 8s linear infinite',
        'blink': 'blink 1s step-end infinite',
      },
      keyframes: {
        'pulse-risk': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        'scan-line': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        'blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
