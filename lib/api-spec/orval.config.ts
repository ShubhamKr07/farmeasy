import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactRoot = path.resolve(root, "lib", "api-client-react");
const apiClientReactSrc = path.resolve(apiClientReactRoot, "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      // orval detects the installed @tanstack/react-query version (to decide
      // whether hook option types wrap in Partial<UseQueryOptions<...>>) by
      // walking up from process.cwd() to the nearest package.json — which,
      // run from lib/api-spec, is lib/api-spec/package.json itself, never
      // api-client-react's. That package.json doesn't depend on react-query
      // at all, so version detection silently fails and every generated
      // hook's `query` option type falls back to pre-v5 behavior (queryKey
      // required instead of optional). Point orval at the real dependent's
      // package.json so it resolves the actual installed version.
      packageJson: path.resolve(apiClientReactRoot, "package.json"),
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      schemas: { path: "generated/types", type: "typescript" },
      mode: "split",
      clean: true,
      prettier: true,
      override: {
        zod: {
          coerce: {
            query: ['boolean', 'number', 'string'],
            param: ['boolean', 'number', 'string'],
            body: ['bigint', 'date'],
            response: ['bigint', 'date'],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
