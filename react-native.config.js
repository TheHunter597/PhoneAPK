/**
 * react-native.config.js — project-level RN CLI configuration.
 *
 * Used by `@react-native-community/cli` to discover native modules and
 * configure autolinking. Without this file, some CLI commands warn or
 * behave unexpectedly.
 */
module.exports = {
    project: {
        ios: {},
        android: {},
    },
    // dependencies are autolinked automatically from package.json — no manual
    // entries needed here.
};
