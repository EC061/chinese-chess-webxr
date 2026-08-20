/**
 * The WebXR canvas.
 *
 * `events={noEvents}` plus `<PointerEvents />` hands interaction to
 * @pmndrs/pointer-events, so controller rays, hand pinches, and a desktop mouse
 * all dispatch the same `onClick` / `onPointerOver` props. Every widget in the
 * scene is therefore written once and works in both places.
 */
import { Canvas } from '@react-three/fiber';
import { PointerEvents, XR, createXRStore, noEvents } from '@react-three/xr';
import { OrbitControls } from '@react-three/drei';
import { Suspense, useMemo } from 'react';
import { ACESFilmicToneMapping, SRGBColorSpace } from 'three';
import { BOARD_Y, SEAT_DISTANCE } from './geometry.js';
import { Scene } from './Scene.js';

export const createStore = () =>
  createXRStore({
    // Foveation is nearly free visually in a seated experience where everything
    // interesting is near the centre of vision, and it buys back real fill rate.
    foveation: 1,
    frameRate: 'high',
    // Do not pop a session offer the moment the page loads — the player picks a
    // game mode first.
    offerSession: false,
    // Emulate a Quest 3 when developing on a desktop with no WebXR runtime.
    // Off in production, where it would only be able to misfire.
    emulate: import.meta.env.DEV ? 'metaQuest3' : false,
    // Hands and controllers both get a ray pointer; teleporting is meaningless
    // in a seated game, so it stays off.
    hand: { rayPointer: { cursorModel: { color: '#b8863c' } }, teleportPointer: false },
    controller: { rayPointer: { cursorModel: { color: '#b8863c' } }, teleportPointer: false },
  });

export type Store = ReturnType<typeof createStore>;

export const XRApp = ({ store }: { store: Store }) => (
  <Canvas
    events={noEvents}
    shadows
    dpr={[1, 2]}
    gl={{
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      outputColorSpace: SRGBColorSpace,
      toneMapping: ACESFilmicToneMapping,
    }}
    camera={{ position: [0, 1.34, SEAT_DISTANCE + 0.34], fov: 42, near: 0.05, far: 30 }}
    onCreated={({ gl }) => {
      gl.setClearColor('#0e0b09', 1);
    }}
  >
    <XR store={store}>
      <PointerEvents />
      <Suspense fallback={null}>
        <Scene />
      </Suspense>
      <FlatControls />
    </XR>
  </Canvas>
);

/** Orbit controls for playing on a screen; disabled once a session starts. */
const FlatControls = () => {
  const target = useMemo<[number, number, number]>(() => [0, BOARD_Y, 0], []);
  return (
    <OrbitControls
      target={target}
      enablePan={false}
      minDistance={0.45}
      maxDistance={1.8}
      minPolarAngle={0.15}
      maxPolarAngle={Math.PI / 2.15}
      enableDamping
      dampingFactor={0.12}
      makeDefault
    />
  );
};
