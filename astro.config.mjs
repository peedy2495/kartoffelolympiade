import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import vercel from "@astrojs/vercel";
import tailwindcss from "@tailwindcss/vite";
import { buildAllowedDomains } from "./src/server/allowed-domains.ts";

// https://astro.build/config
export default defineConfig({
  output: "server",
  adapter: vercel(),
  integrations: [react()],
  security: {
    // Trust only these exact hosts for Host / X-Forwarded-Host handling so
    // Vercel-style requests keep their public https origin and the API's
    // same-origin check accepts legitimate gamemaster mutations.
    allowedDomains: buildAllowedDomains(process.env),
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
