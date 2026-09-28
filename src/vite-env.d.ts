/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
  /** WebSocket endpoint for online play; falls back to the page origin. */
  readonly VITE_NET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
