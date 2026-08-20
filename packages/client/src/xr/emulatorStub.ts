/**
 * Production stand-in for @pmndrs/xr's device emulator.
 *
 * The emulator is genuinely useful in development — it fakes a Quest 3 so the
 * scene can be driven from a desktop browser — but it pulls in about six
 * megabytes of scanned rooms. In production `emulate` is off, so the real module
 * is unreachable; aliasing it away stops the bundler emitting those chunks at
 * all. If something ever does reach this, that is a bug worth hearing about.
 */
export const emulate = (): never => {
  throw new Error('The WebXR emulator is not bundled in production builds.');
};
