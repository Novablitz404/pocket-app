// Expo's default Metro config, plus one exclusion: the Rust/Soroban contracts
// under ./contracts. The app never imports Rust, and contracts/target/ is a
// multi-GB Cargo build dir — letting Metro crawl/watch it would bloat the file
// map, slow bundling, and can exhaust file-watcher limits. Blocking the whole
// contracts/ tree keeps it entirely out of the JS build. This does NOT affect
// the shipped iOS/Android bundle (Rust was never bundled); it only keeps the
// dev bundler and EAS uploads from walking into it.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const existing = config.resolver.blockList;
const asArray = Array.isArray(existing) ? existing : existing ? [existing] : [];
config.resolver.blockList = [...asArray, /\/contracts\/.*/];

module.exports = config;
