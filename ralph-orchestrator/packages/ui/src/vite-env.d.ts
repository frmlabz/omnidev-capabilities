/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_DAEMON_URLS?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
