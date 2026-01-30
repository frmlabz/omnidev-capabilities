import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { daemonDiscoveryPlugin } from "./vite-plugin-discovery";

export default defineConfig({
	plugins: [react(), daemonDiscoveryPlugin()],
	resolve: {
		alias: {
			"@": resolve(__dirname, "./src"),
		},
	},
	server: {
		port: 3000,
	},
});
