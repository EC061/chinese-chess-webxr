/**
 * The board, the pieces, and everything drawn on the surface.
 *
 * Two notes on how this is put together:
 *
 * - The board group is unrotated in world space, with the surface mesh itself
 *   turned to lie flat. That keeps `squareToPosition` usable directly for pieces
 *   and markers, and it means the world board is identical for both players —
 *   Black simply sits on the other side rather than seeing a mirrored board.
 *
 * - Piece meshes are keyed by square, so a piece that moves is a fresh mount.
 *   Rather than tracking piece identities across snapshots, the arriving piece
 *   is told where it came from and animates in from there. Same visual result,
 *   none of the bookkeeping.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import {
  AdditiveBlending, CircleGeometry, CylinderGeometry, DoubleSide, Group, Mesh, Vector3,
} from 'three';
import { EMPTY, RED, colorOf, hoverLabel, type Piece } from '@ccx/shared';
import type { Lang } from '../i18n/index.js';
import type { Snapshot } from '../state/gameController.js';
import {
  BOARD_HEIGHT, BOARD_THICKNESS, BOARD_WIDTH, CELL, PIECE_HEIGHT, PIECE_LIFT, PIECE_RADIUS,
  positionToSquare, squareToPosition,
} from './geometry.js';
import { getBoardTexture, getPieceEdgeTexture, getPieceTexture, getTextTexture, PALETTE } from './textures.js';

const SURFACE_Y = 0.0006;
const MARKER_Y = 0.0012;

export interface BoardViewProps {
  snapshot: Snapshot;
  lang: Lang;
  pieceLabels: 'zh' | 'both';
  onSquare(square: number): void;
  /** The square the opponent is currently holding a piece over, if any. */
  peerGrab?: number | null;
  interactive?: boolean;
}

export const BoardView = ({
  snapshot, lang, pieceLabels, onSquare, peerGrab, interactive = true,
}: BoardViewProps) => {
  const [hover, setHover] = useState<{ square: number; piece: Piece } | null>(null);
  const boardTexture = useMemo(() => getBoardTexture(), []);
  const edgeTexture = useMemo(() => getPieceEdgeTexture(), []);
  const targets = useMemo(() => new Set(snapshot.targets), [snapshot.targets]);

  const handlePointer = (event: ThreeEvent<PointerEvent | MouseEvent>, commit: boolean) => {
    // The board group sits at the origin in XZ, so the world hit point maps
    // straight onto board coordinates.
    const square = positionToSquare(event.point.x, event.point.z);
    if (square < 0) return;
    if (commit) {
      event.stopPropagation();
      onSquare(square);
    }
  };

  return (
    <group>
      {/* Wooden body of the board. */}
      <mesh position={[0, -BOARD_THICKNESS / 2, 0]} receiveShadow>
        <boxGeometry args={[BOARD_WIDTH + 0.012, BOARD_THICKNESS, BOARD_HEIGHT + 0.012]} />
        <meshStandardMaterial color="#7a4f24" roughness={0.75} metalness={0.03} />
      </mesh>

      {/* Playing surface, plus a slightly larger invisible plane so taps just
          outside a line still resolve to the nearest point. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, SURFACE_Y, 0]} receiveShadow>
        <planeGeometry args={[BOARD_WIDTH, BOARD_HEIGHT]} />
        <meshStandardMaterial map={boardTexture} roughness={0.62} metalness={0} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, SURFACE_Y + 0.0002, 0]}
        visible={false}
        onClick={interactive ? (event) => handlePointer(event, true) : undefined}
      >
        <planeGeometry args={[BOARD_WIDTH, BOARD_HEIGHT]} />
        <meshBasicMaterial side={DoubleSide} />
      </mesh>

      <Markers snapshot={snapshot} targets={targets} peerGrab={peerGrab ?? null} />

      {[...snapshot.squares].map((piece, square) => {
        if (piece === EMPTY) return null;
        const isSelected = snapshot.selected === square;
        return (
          <PieceMesh
            key={square}
            square={square}
            piece={piece}
            labels={pieceLabels}
            edgeTexture={edgeTexture}
            lifted={isSelected}
            arrivingFrom={snapshot.lastMove?.to === square ? snapshot.lastMove.from : null}
            dimmed={snapshot.mode === 'tutorial' && snapshot.obstacles.includes(square)}
            onSelect={interactive ? () => onSquare(square) : undefined}
            onHover={(state) => setHover(state ? { square, piece } : null)}
          />
        );
      })}

      {hover ? <HoverLabel square={hover.square} piece={hover.piece} lang={lang} /> : null}
    </group>
  );
};

// ------------------------------------------------------------------- markers --

const Markers = ({
  snapshot, targets, peerGrab,
}: { snapshot: Snapshot; targets: Set<number>; peerGrab: number | null }) => {
  const pulse = useRef<Group>(null);
  useFrame((state) => {
    if (pulse.current) {
      const t = state.clock.elapsedTime;
      const scale = 1 + Math.sin(t * 3.4) * 0.08;
      pulse.current.scale.setScalar(scale);
    }
  });

  return (
    <group>
      {/* Legal destinations. A ring for captures, a dot for quiet moves, which
          is the one distinction a player needs to read at a glance. */}
      {[...targets].map((square) => {
        const occupied = snapshot.squares[square] !== EMPTY;
        const [x, , z] = squareToPosition(square);
        return occupied ? (
          <mesh key={square} position={[x, MARKER_Y, z]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[PIECE_RADIUS * 0.94, PIECE_RADIUS * 1.14, 32]} />
            <meshBasicMaterial color={PALETTE.danger} transparent opacity={0.92} toneMapped={false} />
          </mesh>
        ) : (
          <mesh key={square} position={[x, MARKER_Y, z]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[CELL * 0.17, 24]} />
            <meshBasicMaterial color={PALETTE.highlight} transparent opacity={0.85} toneMapped={false} />
          </mesh>
        );
      })}

      {snapshot.selected !== null ? (
        <SquareRing square={snapshot.selected} color={PALETTE.highlight} inner={0.9} outer={1.16} />
      ) : null}

      {snapshot.lastMove ? (
        <>
          <SquareRing square={snapshot.lastMove.from} color={PALETTE.lastMove} inner={0.92} outer={1.06} opacity={0.55} />
          <SquareRing square={snapshot.lastMove.to} color={PALETTE.lastMove} inner={0.98} outer={1.18} opacity={0.85} />
        </>
      ) : null}

      {snapshot.checkSquare !== null && snapshot.checkSquare >= 0 ? (
        <group ref={pulse} position={squareToPosition(snapshot.checkSquare)}>
          <mesh position={[0, MARKER_Y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[PIECE_RADIUS * 1.05, PIECE_RADIUS * 1.4, 40]} />
            <meshBasicMaterial
              color={PALETTE.danger}
              transparent
              opacity={0.9}
              blending={AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        </group>
      ) : null}

      {/* Tutorial: the piece or square doing the blocking. */}
      {snapshot.obstacles.map((square) => (
        <SquareRing key={`obstacle-${square}`} square={square} color="#e0a53a" inner={1.12} outer={1.34} opacity={0.9} />
      ))}

      {snapshot.hint ? (
        <>
          <SquareRing square={snapshot.hint.from} color={PALETTE.hint} inner={1.02} outer={1.24} />
          <SquareRing square={snapshot.hint.to} color={PALETTE.hint} inner={0.5} outer={0.78} />
        </>
      ) : null}

      {peerGrab !== null && peerGrab >= 0 ? (
        <SquareRing square={peerGrab} color="#c8a2ff" inner={1.2} outer={1.42} opacity={0.8} />
      ) : null}
    </group>
  );
};

const SquareRing = ({
  square, color, inner, outer, opacity = 1,
}: { square: number; color: string; inner: number; outer: number; opacity?: number }) => {
  const [x, , z] = squareToPosition(square);
  return (
    <mesh position={[x, MARKER_Y, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[PIECE_RADIUS * inner, PIECE_RADIUS * outer, 40]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} toneMapped={false} />
    </mesh>
  );
};

// -------------------------------------------------------------------- pieces --

const pieceGeometry = new CylinderGeometry(PIECE_RADIUS, PIECE_RADIUS * 0.96, PIECE_HEIGHT, 40, 1, false);
/** The engraved face, laid on top of the disc. */
const faceGeometry = new CircleGeometry(PIECE_RADIUS * 0.995, 40);

const PieceMesh = ({
  square, piece, labels, edgeTexture, lifted, arrivingFrom, dimmed, onSelect, onHover,
}: {
  square: number;
  piece: Piece;
  labels: 'zh' | 'both';
  edgeTexture: ReturnType<typeof getPieceEdgeTexture>;
  lifted: boolean;
  arrivingFrom: number | null;
  dimmed: boolean;
  onSelect?: () => void;
  onHover(state: boolean): void;
}) => {
  const group = useRef<Group>(null);
  const [hovered, setHovered] = useState(false);
  const faceTexture = useMemo(() => getPieceTexture(piece, labels), [piece, labels]);

  const target = useMemo(() => {
    const [x, , z] = squareToPosition(square);
    return new Vector3(x, PIECE_HEIGHT / 2, z);
  }, [square]);

  const start = useMemo(() => {
    if (arrivingFrom === null) return target.clone();
    const [x, , z] = squareToPosition(arrivingFrom);
    // Come in slightly raised, as if the piece was carried rather than slid.
    return new Vector3(x, PIECE_HEIGHT / 2 + PIECE_LIFT * 0.6, z);
  }, [arrivingFrom, target]);

  useEffect(() => {
    group.current?.position.copy(start);
  }, [start]);

  useFrame((_, delta) => {
    const node = group.current;
    if (!node) return;
    const wanted = target.y + (lifted ? PIECE_LIFT : 0) + (hovered && !lifted ? 0.004 : 0);
    // Critically-damped-ish approach: fast enough to feel responsive at 90 Hz,
    // slow enough to read as a physical movement.
    const k = 1 - Math.exp(-18 * delta);
    node.position.x += (target.x - node.position.x) * k;
    node.position.z += (target.z - node.position.z) * k;
    node.position.y += (wanted - node.position.y) * k;
  });

  return (
    <group ref={group}>
      <mesh
        geometry={pieceGeometry}
        castShadow
        onClick={onSelect ? (event) => { event.stopPropagation(); onSelect(); } : undefined}
        onPointerOver={(event) => { event.stopPropagation(); setHovered(true); onHover(true); }}
        onPointerOut={() => { setHovered(false); onHover(false); }}
      >
        {/* Cylinder material order is [side, top, bottom]. */}
        <meshStandardMaterial attach="material-0" map={edgeTexture} roughness={0.55} metalness={0.02} />
        <meshStandardMaterial attach="material-1" color={PALETTE.ivory} roughness={0.5} />
        <meshStandardMaterial attach="material-2" color={PALETTE.ivoryShade} roughness={0.7} />
      </mesh>
      {/* The face, on its own disc so the character is not mirrored. */}
      <mesh
        geometry={faceGeometry}
        position={[0, PIECE_HEIGHT / 2 + 0.0002, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={() => null}
      >
        <meshStandardMaterial
          map={faceTexture}
          roughness={0.42}
          metalness={0.02}
          emissive={hovered ? '#3a2a12' : '#000000'}
          emissiveIntensity={hovered ? 0.4 : 0}
          opacity={dimmed ? 0.55 : 1}
          transparent={dimmed}
        />
      </mesh>
    </group>
  );
};

// --------------------------------------------------------------- hover label --

/**
 * The floating name of the piece under the pointer. In English mode this leads
 * with the English name and keeps the character underneath, which is how someone
 * learns to read the board instead of relying on the label forever.
 */
const HoverLabel = ({ square, piece, lang }: { square: number; piece: Piece; lang: Lang }) => {
  const group = useRef<Group>(null);
  const { title, subtitle } = useMemo(() => hoverLabel(piece, lang), [piece, lang]);
  const isRed = colorOf(piece) === RED;

  const titleTex = useMemo(
    () => getTextTexture(title, { size: 46, weight: 700, color: isRed ? '#ffd9c9' : '#dfe6ff', align: 'center' }),
    [title, isRed],
  );
  const subTex = useMemo(
    () => getTextTexture(subtitle, { size: 30, weight: 500, color: '#c9bba9', align: 'center' }),
    [subtitle],
  );

  const [x, , z] = squareToPosition(square);
  const titleH = 0.016;
  const subH = 0.011;
  const width = Math.max(titleTex.aspect * titleH, subTex.aspect * subH) + 0.022;

  // Face the viewer without tipping: labels stay upright, which reads better
  // than a fully free billboard when you lean over a table.
  useFrame((state) => {
    const node = group.current;
    if (!node) return;
    const camera = state.camera.position;
    node.rotation.y = Math.atan2(camera.x - node.position.x, camera.z - node.position.z);
  });

  return (
    <group ref={group} position={[x, PIECE_HEIGHT + 0.062, z]}>
      <mesh position={[0, 0, -0.002]}>
        <planeGeometry args={[width, 0.044]} />
        <meshBasicMaterial color="#120f0d" transparent opacity={0.82} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.008, 0]}>
        <planeGeometry args={[titleTex.aspect * titleH, titleH]} />
        <meshBasicMaterial map={titleTex.texture} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.011, 0]}>
        <planeGeometry args={[subTex.aspect * subH, subH]} />
        <meshBasicMaterial map={subTex.texture} transparent depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
};

export { pieceGeometry };
export type { Mesh };
