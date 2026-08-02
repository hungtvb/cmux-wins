import {
  Children,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

const MIN_SPLIT_RATIO = 28;
const MAX_SPLIT_RATIO = 72;
const KEYBOARD_STEP = 4;

export function clampSplitRatio(value: number): number {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, Math.round(value * 10) / 10));
}

type ResizablePaneGridProps = {
  children: ReactNode;
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
};

type SplitGridStyle = CSSProperties & {
  "--pane-split": string;
};

export function ResizablePaneGrid({
  children,
  splitRatio,
  onSplitRatioChange,
}: ResizablePaneGridProps) {
  const panes = Children.toArray(children);
  const boundsRef = useRef<DOMRect | null>(null);
  const isResizable = panes.length === 2;
  const ratio = clampSplitRatio(splitRatio);

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = boundsRef.current;
    if (!bounds || bounds.width <= 0) return;

    const nextRatio = ((event.clientX - bounds.left) / bounds.width) * 100;
    onSplitRatioChange(clampSplitRatio(nextRatio));
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const grid = event.currentTarget.parentElement;
    if (!grid) return;

    boundsRef.current = grid.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    updateFromPointer(event);
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    boundsRef.current = null;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextRatio = ratio;
    if (event.key === "ArrowLeft") nextRatio -= KEYBOARD_STEP;
    else if (event.key === "ArrowRight") nextRatio += KEYBOARD_STEP;
    else if (event.key === "Home") nextRatio = MIN_SPLIT_RATIO;
    else if (event.key === "End") nextRatio = MAX_SPLIT_RATIO;
    else if (event.key === "Enter" || event.key === " ") nextRatio = 50;
    else return;

    event.preventDefault();
    onSplitRatioChange(clampSplitRatio(nextRatio));
  };

  const style = isResizable
    ? ({ "--pane-split": `${ratio}%` } satisfies SplitGridStyle)
    : undefined;

  return (
    <div className={`pane-grid${isResizable ? " pane-grid--resizable" : ""}`} style={style}>
      {panes.map((pane, index) => (
        <div className="pane-grid__cell" key={index}>
          {pane}
        </div>
      ))}

      {isResizable && (
        <div
          className="pane-resizer"
          role="separator"
          aria-label="Resize panes"
          aria-orientation="vertical"
          aria-valuemin={MIN_SPLIT_RATIO}
          aria-valuemax={MAX_SPLIT_RATIO}
          aria-valuenow={Math.round(ratio)}
          tabIndex={0}
          onDoubleClick={() => onSplitRatioChange(50)}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          <span />
        </div>
      )}
    </div>
  );
}
