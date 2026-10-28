import {
  initEventLogger,
  initTracing,
  loadAllPlugins,
} from "@karakeep/shared-server";

await loadAllPlugins();
await initTracing("web");
await initEventLogger("web");

if (process.env.KARAKEEP_ENGINE === "rust") {
  const { startWorkService } =
    await import("@karakeep/trpc/services/processing/server");
  await startWorkService();
}
