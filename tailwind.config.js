/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          green: '#009944',
          orange: '#FF8C00',
        },
      },
    },
  },
  plugins: [],
}