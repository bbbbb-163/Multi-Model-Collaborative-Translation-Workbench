import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
const privateData = resolve(process.env.WORKBENCH_DATA || ".data").replace(
  /\\/g,
  "/",
);
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    fs: {
      strict: true,
      allow: [resolve(".")],
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
        "**/.data/**",
        "**/runtime/**",
        "**/backups/**",
        "**/release/**",
        "**/server/**",
        "**/*.sqlite*",
        "**/admin-setup.txt",
        "**/*.log",
        `${privateData}/**`,
      ],
    },
  },
  build: { outDir: "dist" },
});
