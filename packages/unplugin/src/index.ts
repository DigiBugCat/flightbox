import { createUnplugin } from "unplugin";
import { createTransformer, type TransformOptions } from "@flightbox/register";

export interface FlightboxPluginOptions extends TransformOptions {}

export const unpluginFactory = (options?: FlightboxPluginOptions) => {
  const transform = createTransformer({
    include: options?.include,
    exclude: options?.exclude ?? ["**/node_modules/**", "**/*.test.*", "**/*.spec.*"],
  });

  return {
    name: "unplugin-flightbox",

    transformInclude(id: string): boolean {
      return /\.[jt]sx?$/.test(id) && !id.includes("node_modules");
    },

    transform(code: string, id: string) {
      const result = transform(code, id);
      if (!result) return null;
      return { code: result.code, map: result.map as any };
    },
  };
};

export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory);
export default unplugin;
