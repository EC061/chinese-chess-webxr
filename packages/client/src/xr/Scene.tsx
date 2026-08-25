/**
 * Scene assembly: where the player sits, what they see, and what the other
 * player sees of them.
 *
 * Both players share one world. Black is not shown a mirrored board — Black is
 * placed on the far side of the table and turned around, which is why the
 * avatars, the pieces, and a pointed finger all line up between headsets.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { XROrigin, useXR, useXRInputSourceState } from '@react-three/xr';
import { useRef } from 'react';
import { Quaternion, Vector3 } from 'three';
import { BLACK, RED, type Color } from '@ccx/shared';
import { useStore } from '../state/store.js';
import { Avatar, type Pose } from './Avatar.js';
import { BoardView } from './BoardView.js';
import { Environment, Lighting } from './Environment.js';
import { BOARD_Y, SEAT_DISTANCE } from './geometry.js';
import {
  AiSetupPanel, EmoteBar, GamePanel, LinkPanel, LobbyPanel, MenuPanel, PromptOverlay, ResultPanel,
  RoomWaitingPanel, TutorialPanel,
} from './Panels.js';

/** Broadcast presence at 12 Hz: enough to read a lean, cheap on the wire. */
const POSE_INTERVAL_MS = 1000 / 12;

const scratchPosition = new Vector3();
const scratchQuaternion = new Quaternion();

const poseOf = (object: { getWorldPosition(v: Vector3): Vector3; getWorldQuaternion(q: Quaternion): Quaternion }): Pose => {
  object.getWorldPosition(scratchPosition);
  object.getWorldQuaternion(scratchQuaternion);
  return [
    Number(scratchPosition.x.toFixed(3)), Number(scratchPosition.y.toFixed(3)), Number(scratchPosition.z.toFixed(3)),
    Number(scratchQuaternion.x.toFixed(3)), Number(scratchQuaternion.y.toFixed(3)),
    Number(scratchQuaternion.z.toFixed(3)), Number(scratchQuaternion.w.toFixed(3)),
  ];
};

export const Scene = () => {
  const snapshot = useStore((state) => state.snapshot);
  const settings = useStore((state) => state.settings);
  const lang = useStore((state) => state.lang);
  const seat = useStore((state) => state.seat);
  const room = useStore((state) => state.room);
  const peerPose = useStore((state) => state.peerPose);
  const peerEmote = useStore((state) => state.peerEmote);
  const peerGrab = useStore((state) => state.peerGrab);
  const tap = useStore((state) => state.tap);
  const screen = useStore((state) => state.screen);
  const seatOffset = useStore((state) => state.seatOffset);

  const mode = useXR((state) => state.mode);
  const passthrough = mode === 'immersive-ar';
  // The 3D panels are the interface *inside* a headset. On a screen the DOM
  // interface does that job, and drawing both would put a floating slab across
  // the board.
  const immersive = mode === 'immersive-vr' || mode === 'immersive-ar';

  // Which side of the table this player sits on. The tutorial and Red always
  // sit at +Z; Black sits opposite and is turned to face back across the board.
  const myColor: Color | null = snapshot.myColor;
  const seatSign: 1 | -1 = myColor === BLACK ? -1 : 1;
  const seatRotation = myColor === BLACK ? Math.PI : 0;

  const opponent = room
    ? room.seats[myColor === BLACK ? RED : BLACK]
    : null;

  return (
    <group>
      <Lighting passthrough={passthrough} />
      <Environment passthrough={passthrough} />

      <XROrigin
        position={[seatOffset.x, 0, SEAT_DISTANCE * seatSign + seatOffset.z]}
        rotation={[0, seatRotation, 0]}
      />
      <Recentre seatSign={seatSign} />
      <PoseBroadcast enabled={Boolean(room)} />

      <group position={[0, BOARD_Y, 0]}>
        <BoardView
          snapshot={snapshot}
          lang={lang}
          pieceLabels={settings.pieceLabels}
          peerGrab={peerGrab}
          onSquare={tap}
          interactive={screen === 'room' || screen === 'tutorial'}
        />
      </group>

      {opponent ? (
        <Avatar
          pose={peerPose}
          name={opponent.name}
          rating={opponent.rating}
          seatSide={myColor === BLACK ? 1 : -1}
          emote={peerEmote}
          lang={lang}
        />
      ) : null}

      {/* Panels live in player space: +X is the player's right, +Z is nearer. */}
      <group rotation={[0, seatRotation, 0]} visible={immersive}>
        {immersive ? <MenuPanel /> : null}
        {immersive ? <LinkPanel /> : null}
        {immersive ? <AiSetupPanel /> : null}
        {immersive ? <LobbyPanel /> : null}
        {immersive ? <TutorialPanel /> : null}
        {immersive && screen === 'room' ? (
          <>
            <GamePanel />
            <RoomWaitingPanel />
            <PromptOverlay />
            <ResultPanel />
            <EmoteBar />
          </>
        ) : null}
      </group>
    </group>
  );
};

/** Send head and hand poses to the other player while in a room. */
const PoseBroadcast = ({ enabled }: { enabled: boolean }) => {
  const camera = useThree((state) => state.camera);
  const sendPose = useStore((state) => state.sendPose);
  const left = useXRInputSourceState('controller', 'left');
  const right = useXRInputSourceState('controller', 'right');
  const leftHand = useXRInputSourceState('hand', 'left');
  const rightHand = useXRInputSourceState('hand', 'right');
  const lastSent = useRef(0);

  useFrame(() => {
    if (!enabled) return;
    const now = performance.now();
    if (now - lastSent.current < POSE_INTERVAL_MS) return;
    lastSent.current = now;

    const hands: Pose[] = [];
    const leftObject = left?.object ?? leftHand?.object;
    const rightObject = right?.object ?? rightHand?.object;
    if (leftObject) hands.push(poseOf(leftObject));
    if (rightObject) hands.push(poseOf(rightObject));

    sendPose(poseOf(camera), hands);
  });

  return null;
};

/**
 * Re-seat the player so the board sits squarely in front of wherever they
 * actually are. Headsets recentre by holding the system button, but that also
 * moves the system menus; doing it in-app is friendlier and it is the first
 * thing anyone asks for after sitting down in a different chair.
 */
const Recentre = ({ seatSign }: { seatSign: 1 | -1 }) => {
  const camera = useThree((state) => state.camera);
  const nonce = useStore((state) => state.recentreNonce);
  const setSeatOffset = useStore((state) => state.setSeatOffset);
  const handled = useRef(0);

  useFrame(() => {
    if (nonce === handled.current) return;
    handled.current = nonce;
    camera.getWorldPosition(scratchPosition);
    const offset = useStore.getState().seatOffset;
    // Shift the origin by however far the head has drifted from the seat.
    setSeatOffset({
      x: offset.x - scratchPosition.x,
      z: offset.z - (scratchPosition.z - SEAT_DISTANCE * seatSign),
    });
  });

  return null;
};
