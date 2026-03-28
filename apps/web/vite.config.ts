import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const securityHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'; img-src 'self' blob: data:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), autoplay=(), fullscreen=(self)",
  "X-Frame-Options": "DENY",
};

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: {
    target: "esnext",
  },
  server: {
    headers: securityHeaders,
  },
  preview: {
    headers: securityHeaders,
  },
  optimizeDeps: {
    exclude: ["pdf-wasm-pkg"],
  },
  worker: {
    format: "es",
  },
});
