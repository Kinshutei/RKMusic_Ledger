import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages の公開先 https://kinshutei.github.io/RKMusic_Ledger/
export default defineConfig({
  plugins: [react()],
  base: '/RKMusic_Ledger/',
})
