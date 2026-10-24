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

// Ensure singleton React 18 / React Native resolution from `mobile/node_modules`.
config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, "node_modules/react"),
  "react-native": path.resolve(projectRoot, "node_modules/react-native"),
};

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("@web-lib/")) {
    const target = path.resolve(workspaceRoot, "lib", moduleName.slice("@web-lib/".length));
    return context.resolveRequest(context, target, platform);
  }
  if (moduleName.startsWith("@/lib/")) {
    const target = path.resolve(workspaceRoot, "lib", moduleName.slice("@/lib/".length));
    return context.resolveRequest(context, target, platform);
  }
  if (moduleName.startsWith("@/")) {
    const target = path.resolve(projectRoot, "src", moduleName.slice("@/".length));
    return context.resolveRequest(context, target, platform);
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
