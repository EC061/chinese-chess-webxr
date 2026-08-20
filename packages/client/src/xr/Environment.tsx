/**
 * The room the game happens in: a table, two stools, a floor, and light.
 *
 * All of it is procedural geometry. A seated tabletop experience only ever shows
 * the player a couple of square metres, so an asset pipeline would cost download
 * time and cold-start latency to render less than this does. In passthrough the
 * whole environment is hidden and the board floats on the player's real table.
 */
import { useMemo } from 'react';
import { DoubleSide } from 'three';
import { SEAT_DISTANCE, TABLE_HEIGHT, TABLE_RADIUS } from './geometry.js';

export const Environment = ({ passthrough }: { passthrough: boolean }) => {
  if (passthrough) return <PassthroughAnchors />;
  return (
    <group>
      <Floor />
      <Walls />
      <Table />
      <Stool position={[0, 0, SEAT_DISTANCE + 0.14]} />
      <Stool position={[0, 0, -SEAT_DISTANCE - 0.14]} />
      <Lantern position={[0, 1.72, 0]} />
    </group>
  );
};

/** In passthrough we draw only a faint pad, so the board has a visual footing. */
const PassthroughAnchors = () => (
  <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, TABLE_HEIGHT + 0.0005, 0]}>
    <circleGeometry args={[TABLE_RADIUS * 0.92, 48]} />
    <meshBasicMaterial color="#000000" transparent opacity={0.18} />
  </mesh>
);

const Floor = () => (
  <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
    <circleGeometry args={[3.2, 48]} />
    <meshStandardMaterial color="#2a211b" roughness={0.9} metalness={0} />
  </mesh>
);

const Walls = () => (
  <mesh position={[0, 1.6, 0]}>
    <cylinderGeometry args={[3.2, 3.2, 3.2, 40, 1, true]} />
    <meshStandardMaterial color="#1b1512" roughness={1} side={DoubleSide} />
  </mesh>
);

const Table = () => (
  <group>
    {/* Top */}
    <mesh position={[0, TABLE_HEIGHT - 0.018, 0]} castShadow receiveShadow>
      <cylinderGeometry args={[TABLE_RADIUS, TABLE_RADIUS, 0.036, 56]} />
      <meshStandardMaterial color="#5b3d26" roughness={0.68} metalness={0.04} />
    </mesh>
    {/* Inlaid felt, so the board does not sit on bare wood. */}
    <mesh position={[0, TABLE_HEIGHT + 0.0002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[TABLE_RADIUS * 0.94, 56]} />
      <meshStandardMaterial color="#33503d" roughness={0.95} />
    </mesh>
    {/* Pedestal and foot */}
    <mesh position={[0, (TABLE_HEIGHT - 0.036) / 2, 0]} castShadow>
      <cylinderGeometry args={[0.07, 0.09, TABLE_HEIGHT - 0.036, 24]} />
      <meshStandardMaterial color="#4a3120" roughness={0.72} />
    </mesh>
    <mesh position={[0, 0.02, 0]} castShadow receiveShadow>
      <cylinderGeometry args={[0.26, 0.28, 0.04, 32]} />
      <meshStandardMaterial color="#412b1c" roughness={0.8} />
    </mesh>
  </group>
);

const Stool = ({ position }: { position: [number, number, number] }) => (
  <group position={position}>
    <mesh position={[0, 0.44, 0]} castShadow receiveShadow>
      <cylinderGeometry args={[0.16, 0.16, 0.05, 28]} />
      <meshStandardMaterial color="#4a3120" roughness={0.75} />
    </mesh>
    {[
      [0.1, 0.1], [-0.1, 0.1], [0.1, -0.1], [-0.1, -0.1],
    ].map(([x, z], index) => (
      <mesh key={index} position={[x!, 0.21, z!]} castShadow>
        <cylinderGeometry args={[0.014, 0.016, 0.42, 10]} />
        <meshStandardMaterial color="#3e2718" roughness={0.8} />
      </mesh>
    ))}
  </group>
);

/** A warm hanging lamp above the board — the main light and a visual anchor. */
const Lantern = ({ position }: { position: [number, number, number] }) => (
  <group position={position}>
    <mesh>
      <sphereGeometry args={[0.075, 20, 14]} />
      <meshStandardMaterial color="#ffd9a0" emissive="#ffbf6a" emissiveIntensity={2.2} roughness={0.4} />
    </mesh>
    <mesh position={[0, 0.06, 0]}>
      <coneGeometry args={[0.14, 0.1, 24, 1, true]} />
      <meshStandardMaterial color="#2e2018" roughness={0.7} side={DoubleSide} />
    </mesh>
    <mesh position={[0, 0.4, 0]}>
      <cylinderGeometry args={[0.004, 0.004, 0.7, 6]} />
      <meshStandardMaterial color="#1a1310" />
    </mesh>
  </group>
);

/**
 * Lighting. One warm point light over the board carries the scene; a low
 * hemisphere fill keeps the piece faces legible without washing out the
 * engraved characters. Shadows are limited to a single small map because on a
 * standalone headset the frame budget is about 11 ms.
 */
export const Lighting = ({ passthrough }: { passthrough: boolean }) => {
  const shadowCamera = useMemo(() => ({ near: 0.1, far: 4 }), []);
  if (passthrough) {
    // In passthrough the real room provides the light; adding much of our own
    // makes the virtual board look pasted on.
    return (
      <>
        <hemisphereLight args={['#ffffff', '#8a8a8a', 1.1]} />
        <directionalLight position={[0.6, 2, 0.8]} intensity={0.5} />
      </>
    );
  }
  return (
    <>
      <hemisphereLight args={['#5d4a3a', '#191310', 0.7]} />
      <pointLight
        position={[0, 1.62, 0]}
        intensity={7}
        distance={5}
        decay={2}
        color="#ffcf96"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0008}
        shadow-camera-near={shadowCamera.near}
        shadow-camera-far={shadowCamera.far}
      />
      <pointLight position={[-1.1, 1.2, 1.0]} intensity={1.2} distance={4} decay={2} color="#8fb0ff" />
    </>
  );
};
