const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// Watch the parent web repo so `@web-lib/*` (`../lib/*`) resolves and hot-reloads.
config.watchFolders = [workspaceRoot];

// Resolve packages from `mobile/node_modules` first, falling back to `../node_modules`.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
