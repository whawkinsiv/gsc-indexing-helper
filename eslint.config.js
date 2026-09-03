"use strict";

const globals = require("globals");

module.exports = [
  {
    ignores: ["node_modules/**"]
  },
  {
    // The extension files run in the browser as classic content scripts.
    files: ["content.js", "lib.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        ...globals.browser,
        chrome: "readonly",
        module: "readonly",
        GSC_LIB: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^unused" }],
      "no-undef": "error",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }]
    }
  },
  {
    // The tests and the config run in Node.
    files: ["tests/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^unused" }],
      "no-var": "error",
      "prefer-const": "error"
    }
  }
];
