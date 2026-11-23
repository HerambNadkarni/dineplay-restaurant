/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#111313',
        panel: '#1b1e1e',
        amber: '#f5ad45',
        mint: '#85d6a5',
      },
    },
  },
  plugins: [],
}
