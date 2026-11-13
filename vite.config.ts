import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// Cross-origin isolation unlocks SharedArrayBuffer, which onnxruntime-web needs
// for multi-threaded WASM inference (several times faster on CPU).
// `credentialless` keeps cross-origin model/runtime downloads from Hugging Face
// and jsDelivr working without them sending CORP headers.
// Static hosting must send the same two headers to get the speed-up.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

// localhost is already a secure context, so the mic works over plain http.
// HTTPS (self-signed) is opt-in for testing from other devices on the LAN:
// `npm run dev:lan`. Chrome disables Cache Storage on origins with certificate
// errors, so model saving does not work in that mode.

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode === 'lan' ? [basicSsl()] : [])
  ],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' as const },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
}))
