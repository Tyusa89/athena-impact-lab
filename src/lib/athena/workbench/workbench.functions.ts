import { createServerFn } from "@tanstack/react-start";

// Server functions only. The browser sends dataset, scenario and role ids and a question; the server decides everything else, and returns a presentation view.
// The engine runs here and calls no model provider: nothing on this path needs a key or a network.
export const getWorkbenchOptions = createServerFn({ method: "GET" }).handler(async () => {
  const { workbenchOptions } = await import("./workbench.server");
  return workbenchOptions();
});

export const runImpactWorkbench = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async ({ data }) => {
    const { runWorkbench } = await import("./workbench.server");
    return runWorkbench(data);
  });
