// @ts-check

// Missing meta — validatePluginShape must reject this.
const plugin = {
  execute: async () => ({ data: {} }),
};

module.exports = plugin;
