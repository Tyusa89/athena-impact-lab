import { createServerFn } from "@tanstack/react-start";

// Server functions only. The API key is read inside handlers and never returned to the browser.
export const getMetaStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { metaStatus } = await import("./meta/adapter.server");
  return metaStatus({ META_MODEL_API_KEY: process.env["META_MODEL_API_KEY"], META_MODEL_ENABLED: process.env["META_MODEL_ENABLED"] });
});

export const runMetaComparison = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => data)
  .handler(async ({ data }) => {
    const { runMeta } = await import("./meta/adapter.server");
    return runMeta(data, { META_MODEL_API_KEY: process.env["META_MODEL_API_KEY"], META_MODEL_ENABLED: process.env["META_MODEL_ENABLED"] }, fetch);
  });
