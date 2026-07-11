// Custom entry: polyfills must load before expo-router evaluates any route
// module (routes import the Stellar SDK, which needs Event/EventTarget/Buffer).
import './src/lib/polyfills';
import 'expo-router/entry';
