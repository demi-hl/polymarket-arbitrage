/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./index.html"
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'trader': {
          950: '#060609',
          900: '#0a0a0f',
          800: '#12121a',
          700: '#1a1a25',
          600: '#252535',
          500: '#353545',
          400: '#45455a',
        },
        'profit': {
          DEFAULT: '#10b981',
          dark: '#059669',
          light: '#34d399'
        },
        'loss': {
          DEFAULT: '#ef4444',
          dark: '#dc2626',
          light: '#f87171'
        },
        'accent': {
          DEFAULT: '#00d4ff',
          glow: '#60e0ff',
          purple: '#a855f7',
          'purple-glow': '#c084fc',
        },
        'account-a': {
          DEFAULT: '#f59e0b',
          glow: '#fbbf24',
          dim: 'rgba(245, 158, 11, 0.12)',
          border: 'rgba(245, 158, 11, 0.25)',
        },
        'account-b': {
          DEFAULT: '#00d4ff',
          glow: '#67e8f9',
          dim: 'rgba(0, 212, 255, 0.12)',
          border: 'rgba(0, 212, 255, 0.25)',
        },
        'glass': {
          DEFAULT: 'rgba(18, 18, 26, 0.6)',
          heavy: 'rgba(18, 18, 26, 0.8)',
          light: 'rgba(18, 18, 26, 0.4)',
        },
        'surface': {
          elevated: 'rgba(20, 20, 32, 0.8)',
        },
        'accent-warm': '#ff6b35',
      },
      fontFamily: {
        futuristic: ['Space Grotesk', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'monospace'],
        sans: ['Space Grotesk', 'system-ui', 'sans-serif'],
      },
      backdropBlur: {
        xs: '2px',
      },
      animation: {
        'pulse-fast': 'pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite',

        'glow': 'glow 3s ease-in-out infinite alternate',
        'glow-cyan': 'glowCyan 3s ease-in-out infinite alternate',
        'glow-amber': 'glowAmber 3s ease-in-out infinite alternate',

        'slide-up': 'slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-up-delay-1': 'slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.08s forwards',
        'slide-up-delay-2': 'slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.16s forwards',
        'slide-up-delay-3': 'slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.24s forwards',
        'slide-up-delay-4': 'slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.32s forwards',

        'fade-in': 'fadeIn 0.6s ease-out forwards',
        'fade-in-delay-1': 'fadeIn 0.6s ease-out 0.1s forwards',
        'fade-in-delay-2': 'fadeIn 0.6s ease-out 0.2s forwards',

        'scale-in': 'scaleIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards',

        'shimmer': 'shimmer 2.5s ease-in-out infinite',
        'gradient-shift': 'gradientShift 6s ease infinite',
        'border-rotate': 'borderRotate 4s linear infinite',
        'float': 'float 6s ease-in-out infinite',

        'trade-enter': 'tradeEnter 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards',

        'count-up': 'countPulse 0.3s ease-out',

        'breathe': 'breathe 4s ease-in-out infinite',

        'spotlight': 'spotlight 8s ease-in-out infinite',
        'glow-breathe': 'glowBreathe 8s ease-in-out infinite',
        'metric-pop': 'metricPop 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'card-shimmer-hover': 'cardShimmerHover 1.5s ease forwards',
        'border-flow': 'borderFlow 3s linear infinite',
        'draw-line': 'drawLine 1.2s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'heartbeat': 'heartbeat 1.5s ease-in-out infinite',
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(0, 212, 255, 0.2)' },
          '100%': { boxShadow: '0 0 25px rgba(0, 212, 255, 0.4), 0 0 50px rgba(0, 212, 255, 0.1)' },
        },
        glowCyan: {
          '0%': { boxShadow: '0 0 8px rgba(0, 212, 255, 0.15), inset 0 0 8px rgba(0, 212, 255, 0.05)' },
          '100%': { boxShadow: '0 0 20px rgba(0, 212, 255, 0.35), inset 0 0 15px rgba(0, 212, 255, 0.08)' },
        },
        glowAmber: {
          '0%': { boxShadow: '0 0 8px rgba(245, 158, 11, 0.15), inset 0 0 8px rgba(245, 158, 11, 0.05)' },
          '100%': { boxShadow: '0 0 20px rgba(245, 158, 11, 0.35), inset 0 0 15px rgba(245, 158, 11, 0.08)' },
        },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        gradientShift: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        borderRotate: {
          '0%': { '--border-angle': '0deg' },
          '100%': { '--border-angle': '360deg' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        tradeEnter: {
          '0%': { transform: 'translateX(-12px)', opacity: '0', maxHeight: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1', maxHeight: '80px' },
        },
        countPulse: {
          '0%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.05)' },
          '100%': { transform: 'scale(1)' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
        spotlight: {
          '0%, 100%': { opacity: '0.5', transform: 'translateX(-20%) translateY(-20%)' },
          '25%': { opacity: '0.8', transform: 'translateX(20%) translateY(-10%)' },
          '50%': { opacity: '0.5', transform: 'translateX(10%) translateY(20%)' },
          '75%': { opacity: '0.8', transform: 'translateX(-10%) translateY(10%)' },
        },
        glowBreathe: {
          '0%, 100%': { boxShadow: '0 0 8px rgba(0, 212, 255, 0.1), inset 0 0 4px rgba(0, 212, 255, 0.03)' },
          '50%': { boxShadow: '0 0 24px rgba(0, 212, 255, 0.25), inset 0 0 12px rgba(0, 212, 255, 0.06)' },
        },
        metricPop: {
          '0%': { transform: 'scale(1)', color: 'inherit' },
          '40%': { transform: 'scale(1.06)', filter: 'brightness(1.3)' },
          '100%': { transform: 'scale(1)', color: 'inherit' },
        },
        cardShimmerHover: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        borderFlow: {
          '0%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' },
        },
        drawLine: {
          '0%': { strokeDashoffset: '100' },
          '100%': { strokeDashoffset: '0' },
        },
        heartbeat: {
          '0%, 100%': { transform: 'scaleY(0.6)', opacity: '0.4' },
          '25%': { transform: 'scaleY(1.4)', opacity: '1' },
          '50%': { transform: 'scaleY(0.8)', opacity: '0.6' },
          '75%': { transform: 'scaleY(1.1)', opacity: '0.9' },
        },
      },
    },
  },
  plugins: [],
}
