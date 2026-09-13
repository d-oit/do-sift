import type { PluginContext, PluginInstance } from "@do-sift/kernel";

export interface GreeterConfig {
  greeting?: unknown;
}

export function createGreeter(ctx: PluginContext): PluginInstance {
  let greeting = "hello from do-sift";
  const cfg = ctx.config as GreeterConfig;
  if (typeof cfg.greeting === "string") greeting = cfg.greeting;

  return {
    activate(context: PluginContext) {
      context.logger.info(greeting);
      context.events.emit("greeter.activated", { plugin: context.pluginName });
    },
    deactivate() {
      // nothing to release for the sample plugin
    },
  };
}
