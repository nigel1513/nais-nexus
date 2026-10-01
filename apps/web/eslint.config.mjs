import { FlatCompat } from "@eslint/eslintrc";
import jsxA11y from "eslint-plugin-jsx-a11y";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const noDirectFetch = {
  "no-restricted-globals": ["error", { name: "fetch", message: "Use the generated client via features/<domain>/api.ts hooks (M10 §4)." }],
  "no-restricted-properties": [
    "error",
    { object: "window", property: "fetch", message: "Use features/<domain>/api.ts hooks." },
    { object: "globalThis", property: "fetch", message: "Use features/<domain>/api.ts hooks." },
  ],
};

const config = [
  { ignores: [".next/**", "node_modules/**", "src/generated/**", "playwright-report/**", "test-results/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // eslint-config-next already registers the jsx-a11y plugin; add its full recommended rule set on top.
  { rules: jsxA11y.flatConfigs.recommended.rules },
  // @nais/ui form controls render native inputs; teach the label rule about them.
  {
    rules: {
      "jsx-a11y/label-has-associated-control": ["error", { controlComponents: ["Checkbox", "Input", "Select", "Textarea"], assert: "either", depth: 3 }],
    },
  },
  // M10-AT-03: no direct fetch( in components/pages.
  { files: ["src/app/**/*.tsx", "src/features/**/components/**/*.tsx", "src/shared/ui/**/*.tsx"], rules: noDirectFetch },
];

export default config;
