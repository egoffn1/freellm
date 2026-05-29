import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://freellm.dev",
  integrations: [
    starlight({
      title: "FreeLLM",
      description:
        "OpenAI-compatible gateway aggregating 6 free LLM providers with automatic failover, multi-key rotation, and a real-time dashboard.",
      logo: {
        src: "./src/assets/logo.svg",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: "",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800;900&family=Geist+Mono:wght@400;500;600&display=swap",
          },
        },
      ],
      social: {
        github: "https://github.com/Devansh-365/freellm",
      },
      customCss: ["./src/styles/theme.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "introduction" },
            { label: "Quickstart", slug: "quickstart" },
          ],
        },
        {
          label: "Integration",
          items: [
            { label: "Browser integration", slug: "browser-integration" },
          ],
        },
        {
          label: "Features",
          items: [
            { label: "Multi-Key Rotation", slug: "features/multi-key" },
            { label: "Response Caching", slug: "features/caching" },
            { label: "Token Usage Tracking", slug: "features/token-usage" },
            { label: "Meta-Models", slug: "features/meta-models" },
            { label: "Circuit Breakers", slug: "features/circuit-breakers" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "API Reference", slug: "reference/api" },
            { label: "Providers", slug: "reference/providers" },
            { label: "Configuration", slug: "reference/configuration" },
          ],
        },
        {
          label: "Trust",
          items: [
            { label: "Security and dependencies", slug: "security" },
            { label: "Privacy and training", slug: "privacy" },
            { label: "Benchmarks", slug: "benchmarks" },
          ],
        },
        {
          label: "Compare",
          items: [{ label: "vs Other Gateways", slug: "comparison" }],
        },
      ],
      components: {
        // Override Starlight's default head/footer when needed later
      },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      lastUpdated: true,
    }),
  ],
});
