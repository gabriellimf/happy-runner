import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypeScript,
  globalIgnores([
    ".maestri/**",
    ".next/**",
    ".vercel/**",
    "build/**",
    "coverage/**",
    "dist/**",
    "next-env.d.ts",
    "node_modules/**",
    "out/**",
  ]),
]);
