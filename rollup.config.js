const commonjs = require("rollup-plugin-commonjs");
const uglify = require("@lopatnov/rollup-plugin-uglify");

/** @type {import("rollup").RollupOptions} */
const config = {
  input: "./src/index.js",
  output: {
    file: "./dist/index.min.js",
    format: "umd",
    name: "dominlinestylefilter"
  },
  plugins: [commonjs(), uglify()]
};

module.exports = config;
