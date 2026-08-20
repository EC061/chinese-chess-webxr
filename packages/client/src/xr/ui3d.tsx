/**
 * A small 3D widget kit for the in-headset interface.
 *
 * Panels and buttons are real geometry (rounded boxes) rather than textured
 * quads, so nothing distorts at odd aspect ratios and there is no nine-slice to
 * maintain. Text is a canvas texture on a plane, which is what lets the same
 * component render 汉字 and Latin without shipping a font.
 *
 * Every interactive element uses plain R3F pointer props; @react-three/xr routes
 * controller rays, hand pinches, and the mouse through the same events, so the
 * interface works identically in a headset and on a desktop.
 */
import { RoundedBox } from '@react-three/drei';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { DoubleSide, type Mesh } from 'three';
import { getTextTexture, PALETTE } from './textures.js';

export const UI = {
  panel: '#1d1714',
  panelEdge: '#3a2e26',
  raised: '#2a221c',
  accent: '#b8863c',
  accentHot: '#d6a34f',
  danger: '#8f3a30',
  good: '#2f6b45',
  text: '#f2e9db',
  textDim: '#a89684',
  disabled: '#453a32',
} as const;

/** A line (or block) of text, sized by its height in metres. */
export const Label = ({
  text,
  size = 0.018,
  color = UI.text,
  weight = 500,
  align = 'left',
  wrapAt,
  position = [0, 0, 0],
  maxWidth,
  lineHeight = 1.35,
}: {
  text: string;
  /** Cap height in metres. */
  size?: number;
  color?: string;
  weight?: number;
  align?: 'left' | 'center' | 'right';
  /** Wrap width in metres. */
  wrapAt?: number;
  position?: [number, number, number];
  maxWidth?: number;
  lineHeight?: number;
}) => {
  const pxPerMetre = 2200;
  const { texture, aspect } = useMemo(
    () => getTextTexture(text, {
      size: Math.round(size * pxPerMetre),
      color,
      weight,
      align,
      lineHeight,
      maxWidth: wrapAt ? Math.round(wrapAt * pxPerMetre) : 1600,
    }),
    [text, size, color, weight, align, wrapAt, lineHeight],
  );

  // The texture is as tall as its line count, so derive height from the aspect.
  const width = maxWidth ?? size * lineHeight * aspect;
  const height = width / aspect;
  const offsetX = align === 'center' ? 0 : align === 'left' ? width / 2 : -width / 2;

  return (
    <mesh position={[position[0] + offsetX, position[1], position[2]]} renderOrder={2}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} side={DoubleSide} />
    </mesh>
  );
};

export const Panel = ({
  width,
  height,
  color = UI.panel,
  depth = 0.008,
  radius = 0.012,
  opacity = 0.96,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  children,
}: {
  width: number;
  height: number;
  color?: string;
  depth?: number;
  radius?: number;
  opacity?: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  children?: ReactNode;
}) => (
  <group position={position} rotation={rotation}>
    <RoundedBox args={[width, height, depth]} radius={Math.min(radius, depth / 2.01)} smoothness={3}>
      <meshStandardMaterial
        color={color}
        roughness={0.72}
        metalness={0.04}
        transparent={opacity < 1}
        opacity={opacity}
      />
    </RoundedBox>
    <group position={[0, 0, depth / 2 + 0.001]}>{children}</group>
  </group>
);

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'good' | 'ghost';

const variantColor = (variant: ButtonVariant, hovered: boolean, disabled: boolean): string => {
  if (disabled) return UI.disabled;
  switch (variant) {
    case 'primary': return hovered ? UI.accentHot : UI.accent;
    case 'danger': return hovered ? '#a8463b' : UI.danger;
    case 'good': return hovered ? '#3a8355' : UI.good;
    case 'ghost': return hovered ? UI.raised : UI.panel;
    default: return hovered ? '#3a2f27' : UI.raised;
  }
};

export const Button = ({
  label,
  sub,
  width = 0.16,
  height = 0.048,
  variant = 'default',
  disabled = false,
  onClick,
  position = [0, 0, 0],
  textSize,
}: {
  label: string;
  sub?: string;
  width?: number;
  height?: number;
  variant?: ButtonVariant;
  disabled?: boolean;
  onClick: () => void;
  position?: [number, number, number];
  textSize?: number;
}) => {
  const [hovered, setHovered] = useState(false);
  const size = textSize ?? Math.min(0.018, height * 0.38);

  const handleClick = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      if (!disabled) onClick();
    },
    [disabled, onClick],
  );

  return (
    <group position={position}>
      <RoundedBox
        args={[width, height, 0.01]}
        radius={0.004}
        smoothness={3}
        onClick={handleClick}
        onPointerOver={(event) => { event.stopPropagation(); setHovered(true); }}
        onPointerOut={() => setHovered(false)}
      >
        <meshStandardMaterial
          color={variantColor(variant, hovered, disabled)}
          roughness={0.6}
          metalness={0.05}
          emissive={hovered && !disabled ? variantColor(variant, true, false) : '#000000'}
          emissiveIntensity={hovered && !disabled ? 0.18 : 0}
        />
      </RoundedBox>
      <group position={[0, sub ? size * 0.55 : 0, 0.006]}>
        <Label text={label} size={size} align="center" color={disabled ? UI.textDim : UI.text} weight={600} />
      </group>
      {sub ? (
        <group position={[0, -size * 0.95, 0.006]}>
          <Label text={sub} size={size * 0.68} align="center" color={UI.textDim} />
        </group>
      ) : null}
    </group>
  );
};

export const Toggle = ({
  label,
  value,
  onChange,
  width = 0.22,
  position = [0, 0, 0],
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  width?: number;
  position?: [number, number, number];
}) => (
  <group position={position}>
    <Label text={label} size={0.015} position={[-width / 2, 0, 0.002]} />
    <Button
      label={value ? '✓' : ''}
      width={0.036}
      height={0.03}
      variant={value ? 'good' : 'ghost'}
      onClick={() => onChange(!value)}
      position={[width / 2 - 0.018, 0, 0]}
    />
  </group>
);

/** A minus / value / plus row — far more reliable in VR than a drag slider. */
export const Stepper = ({
  label,
  value,
  display,
  min,
  max,
  onChange,
  width = 0.26,
  position = [0, 0, 0],
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  onChange: (value: number) => void;
  width?: number;
  position?: [number, number, number];
}) => (
  <group position={position}>
    <Label text={label} size={0.014} color={UI.textDim} position={[-width / 2, 0.026, 0.002]} />
    <Button
      label="−"
      width={0.04}
      height={0.04}
      disabled={value <= min}
      onClick={() => onChange(Math.max(min, value - 1))}
      position={[-width / 2 + 0.02, -0.008, 0]}
    />
    <Label text={display} size={0.017} align="center" weight={600} position={[0, -0.008, 0.002]} />
    <Button
      label="+"
      width={0.04}
      height={0.04}
      disabled={value >= max}
      onClick={() => onChange(Math.min(max, value + 1))}
      position={[width / 2 - 0.02, -0.008, 0]}
    />
  </group>
);

/**
 * Numeric keypad for room passcodes. Digits only, deliberately: entering text
 * on a headset is miserable, and four to eight digits can be read aloud to a
 * friend in the next room.
 */
export const Keypad = ({
  value,
  onChange,
  onSubmit,
  onCancel,
  title,
  maxLength = 8,
  position = [0, 0, 0],
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  title: string;
  maxLength?: number;
  position?: [number, number, number];
}) => {
  const keySize = 0.05;
  const gap = 0.006;
  const step = keySize + gap;

  const pressDigit = (digit: string) => {
    if (value.length < maxLength) onChange(value + digit);
  };

  return (
    <Panel width={0.24} height={0.32} position={position}>
      <Label text={title} size={0.015} align="center" position={[0, 0.132, 0.002]} />
      <Panel width={0.19} height={0.038} color="#100d0b" depth={0.004} position={[0, 0.094, 0]}>
        <Label
          text={value.replace(/./g, '•') || '––––'}
          size={0.022}
          align="center"
          weight={700}
          color={value ? UI.text : UI.textDim}
          position={[0, 0, 0.002]}
        />
      </Panel>
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit, index) => (
        <Button
          key={digit}
          label={String(digit)}
          width={keySize}
          height={keySize}
          textSize={0.02}
          onClick={() => pressDigit(String(digit))}
          position={[(index % 3 - 1) * step, 0.038 - Math.floor(index / 3) * step, 0]}
        />
      ))}
      <Button
        label="⌫"
        width={keySize}
        height={keySize}
        textSize={0.018}
        onClick={() => onChange(value.slice(0, -1))}
        position={[-step, 0.038 - 3 * step, 0]}
      />
      <Button
        label="0"
        width={keySize}
        height={keySize}
        textSize={0.02}
        onClick={() => pressDigit('0')}
        position={[0, 0.038 - 3 * step, 0]}
      />
      <Button
        label="✓"
        width={keySize}
        height={keySize}
        textSize={0.018}
        variant="primary"
        disabled={value.length < 4}
        onClick={onSubmit}
        position={[step, 0.038 - 3 * step, 0]}
      />
      <Button label="✕" width={0.06} height={0.03} variant="ghost" textSize={0.014} onClick={onCancel} position={[0, -0.142, 0]} />
    </Panel>
  );
};

/**
 * Paged list. Paging beats scrolling in VR: a controller ray drifting a few
 * millimetres should never move the content out from under the thing you were
 * about to press.
 */
export const PagedList = <T,>({
  items,
  perPage,
  page,
  onPage,
  rowHeight,
  width,
  render,
  empty,
  position = [0, 0, 0],
}: {
  items: T[];
  perPage: number;
  page: number;
  onPage: (page: number) => void;
  rowHeight: number;
  width: number;
  render: (item: T, index: number) => ReactNode;
  empty: string;
  position?: [number, number, number];
}) => {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const clamped = Math.min(page, pages - 1);
  const visible = items.slice(clamped * perPage, clamped * perPage + perPage);
  const top = ((perPage - 1) * rowHeight) / 2;

  return (
    <group position={position}>
      {visible.length === 0 ? (
        <Label text={empty} size={0.014} align="center" color={UI.textDim} />
      ) : (
        visible.map((item, index) => (
          <group key={clamped * perPage + index} position={[0, top - index * rowHeight, 0]}>
            {render(item, clamped * perPage + index)}
          </group>
        ))
      )}
      {pages > 1 ? (
        <group position={[0, -top - rowHeight * 0.85, 0]}>
          <Button
            label="▲"
            width={0.05}
            height={0.03}
            textSize={0.014}
            disabled={clamped === 0}
            onClick={() => onPage(clamped - 1)}
            position={[-width / 2 + 0.03, 0, 0]}
          />
          <Label text={`${clamped + 1} / ${pages}`} size={0.013} align="center" color={UI.textDim} />
          <Button
            label="▼"
            width={0.05}
            height={0.03}
            textSize={0.014}
            disabled={clamped >= pages - 1}
            onClick={() => onPage(clamped + 1)}
            position={[width / 2 - 0.03, 0, 0]}
          />
        </group>
      ) : null}
    </group>
  );
};

/** A thin coloured bar, used for evaluation and clock readouts. */
export const Meter = ({
  value,
  width = 0.2,
  height = 0.006,
  color = PALETTE.highlight,
  position = [0, 0, 0],
}: {
  /** 0..1 */
  value: number;
  width?: number;
  height?: number;
  color?: string;
  position?: [number, number, number];
}) => {
  const filled = Math.max(0, Math.min(1, value));
  return (
    <group position={position}>
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial color="#0d0b0a" transparent opacity={0.8} />
      </mesh>
      <mesh position={[-width / 2 + (width * filled) / 2, 0, 0.001]}>
        <planeGeometry args={[width * filled, height]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  );
};

export type { Mesh };
