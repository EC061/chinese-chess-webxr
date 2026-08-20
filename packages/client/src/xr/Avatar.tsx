/**
 * The other player, as seen across the table.
 *
 * There is no rigged character here on purpose: a floating head and two hands
 * driven by real tracking data reads as another person present far better than
 * a low-poly body with no legs and a fixed pose. The head follows their actual
 * gaze, so you can see them studying a corner of the board.
 */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { Group, Quaternion, Vector3 } from 'three';
import { EMOTES, type Emote } from '@ccx/shared';
import type { Lang } from '../i18n/index.js';
import { Label, UI } from './ui3d.js';
import { SEAT_DISTANCE, TABLE_HEIGHT } from './geometry.js';

/** Pose arrays are [x, y, z, qx, qy, qz, qw]. */
export type Pose = number[];

const EMOTE_TEXT: Record<Emote, { zh: string; en: string }> = {
  'good-move': { zh: '好棋！', en: 'Nice move' },
  thinking: { zh: '让我想想…', en: 'Thinking…' },
  hello: { zh: '你好', en: 'Hello' },
  'good-game': { zh: '承让了', en: 'Good game' },
  oops: { zh: '哎呀', en: 'Oops' },
  nice: { zh: '厉害', en: 'Impressive' },
  hurry: { zh: '快点吧', en: 'Your move…' },
  rematch: { zh: '再来一局？', en: 'Again?' },
};

export const emoteLabel = (emote: Emote, lang: Lang): string => EMOTE_TEXT[emote][lang];
export const ALL_EMOTES = EMOTES;

const applyPose = (node: Group, pose: Pose | undefined, fallback: Vector3, lerp: number): void => {
  if (!pose || pose.length < 7) {
    node.position.lerp(fallback, lerp);
    return;
  }
  const target = new Vector3(pose[0]!, pose[1]!, pose[2]!);
  node.position.lerp(target, lerp);
  const quaternion = new Quaternion(pose[3]!, pose[4]!, pose[5]!, pose[6]!);
  node.quaternion.slerp(quaternion, lerp);
};

export const Avatar = ({
  pose, name, rating, seatSide, emote, lang,
}: {
  pose: { head: Pose; hands: Pose[] } | null;
  name: string;
  rating: number | null;
  /** +1 if they sit at +Z, -1 if at -Z. */
  seatSide: 1 | -1;
  emote: { emote: Emote; at: number } | null;
  lang: Lang;
}) => {
  const head = useRef<Group>(null);
  const left = useRef<Group>(null);
  const right = useRef<Group>(null);

  const restHead = new Vector3(0, 1.18, SEAT_DISTANCE * seatSide);
  const restLeft = new Vector3(-0.18, TABLE_HEIGHT + 0.05, SEAT_DISTANCE * seatSide * 0.72);
  const restRight = new Vector3(0.18, TABLE_HEIGHT + 0.05, SEAT_DISTANCE * seatSide * 0.72);

  useFrame((_, delta) => {
    const lerp = 1 - Math.exp(-12 * delta);
    if (head.current) applyPose(head.current, pose?.head, restHead, lerp);
    if (left.current) applyPose(left.current, pose?.hands?.[0], restLeft, lerp);
    if (right.current) applyPose(right.current, pose?.hands?.[1], restRight, lerp);
  });

  const showEmote = emote !== null && Date.now() - emote.at < 4000;

  return (
    <group>
      <group ref={head}>
        <mesh castShadow>
          <sphereGeometry args={[0.105, 24, 18]} />
          <meshStandardMaterial color="#c9a888" roughness={0.62} />
        </mesh>
        {/* A visor, so it is obvious which way they are looking. */}
        <mesh position={[0, 0.005, -0.088]}>
          <boxGeometry args={[0.15, 0.055, 0.03]} />
          <meshStandardMaterial color="#15100d" roughness={0.35} metalness={0.3} />
        </mesh>
        <group position={[0, 0.17, 0]}>
          <Label text={name} size={0.026} align="center" weight={600} />
          {rating !== null ? (
            <group position={[0, -0.032, 0]}>
              <Label text={String(rating)} size={0.019} align="center" color={UI.textDim} />
            </group>
          ) : null}
        </group>
        {showEmote ? (
          <group position={[0, 0.26, 0]}>
            <mesh position={[0, 0, -0.003]}>
              <planeGeometry args={[0.24, 0.055]} />
              <meshBasicMaterial color="#1d1714" transparent opacity={0.9} depthWrite={false} />
            </mesh>
            <Label text={emoteLabel(emote!.emote, lang)} size={0.024} align="center" weight={600} />
          </group>
        ) : null}
      </group>

      {[left, right].map((ref, index) => (
        <group key={index} ref={ref}>
          <mesh castShadow>
            <sphereGeometry args={[0.038, 16, 12]} />
            <meshStandardMaterial color="#c9a888" roughness={0.6} />
          </mesh>
        </group>
      ))}
    </group>
  );
};
