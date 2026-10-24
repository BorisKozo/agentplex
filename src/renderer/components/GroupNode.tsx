import { memo, useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { NodeProps } from '@xyflow/react';
import { useAppStore, groupSharedDirectory, GROUP_COLORS, type GroupNodeData } from '../store';
import { useViewportMenu } from '../hooks/useViewportMenu';

/** Resize cursor for a point on the circle's edge, by its angle from the centre. */
function edgeCursor(dx: number, dy: number): string {
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, y grows downward
  const a = (angle + 360) % 180; // opposite points share a cursor
  if (a < 22.5 || a >= 157.5) return 'ew-resize';
  if (a < 67.5) return 'nwse-resize';
  if (a < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

export const GroupNode = memo(function GroupNode({ data, id }: NodeProps) {
  const nodeData = data as GroupNodeData;
  const color = nodeData.color || '#7aa2f7';
  const groupStyle: CSSProperties & { '--group-color': string } = { '--group-color': color };
  const renameGroup = useAppStore((s) => s.renameGroup);
  const resizeGroup = useAppStore((s) => s.resizeGroup);
  const setGroupColor = useAppStore((s) => s.setGroupColor);
  const viewportMoveCount = useAppStore((s) => s.viewportMoveCount);
  const dropHint = useAppStore((s) => (s.groupDragHint?.groupId === id ? s.groupDragHint.kind : undefined));
  // Special status: every member works in the same directory, shown under the name.
  const sharedDirectory = useAppStore((s) =>
    groupSharedDirectory(s.nodes, s.sessions, id, window.agentPlex.platform));
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(nodeData.label);
  const inputRef = useRef<HTMLInputElement>(null);
  const [colorPicker, setColorPicker] = useState<{ x: number; y: number } | null>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  useViewportMenu(colorPickerRef, colorPicker);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(nodeData.label);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [nodeData.label]);

  const handleBlur = useCallback(() => {
    setEditing(false);
    if (editValue.trim()) {
      renameGroup(id, editValue.trim());
    }
  }, [editValue, id, renameGroup]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleBlur();
    } else if (e.key === 'Escape') {
      setEditing(false);
      setEditValue(nodeData.label);
    }
  }, [handleBlur, nodeData.label]);

  // Resize by dragging the circle's edge: the diameter follows the pointer's distance
  // from the centre, which stays fixed along with the members.
  const groupRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);

  const edgeGeometry = useCallback((e: React.PointerEvent) => {
    const el = groupRef.current!;
    const rect = el.getBoundingClientRect();
    return {
      dx: e.clientX - (rect.left + rect.width / 2),
      dy: e.clientY - (rect.top + rect.height / 2),
      zoom: rect.width / el.offsetWidth, // screen px per canvas unit
    };
  }, []);

  const handleEdgePointerDown = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  }, []);

  const handleEdgePointerMove = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    const { dx, dy, zoom } = edgeGeometry(e);
    if (!resizing) {
      e.currentTarget.style.cursor = edgeCursor(dx, dy);
      return;
    }
    resizeGroup(id, (2 * Math.hypot(dx, dy)) / zoom, { recenter: true, keepMembersInPlace: true });
  }, [edgeGeometry, id, resizeGroup, resizing]);

  const handleEdgePointerUp = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setResizing(false);
  }, []);

  const handleSwatchContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setColorPicker({ x: e.clientX, y: e.clientY });
  }, []);

  const pickColor = useCallback((next: string) => {
    setGroupColor(id, next);
  }, [id, setGroupColor]);

  // Dismiss on viewport pan/zoom (React Flow's onMove)
  useEffect(() => {
    if (colorPicker) setColorPicker(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportMoveCount]);

  // Dismiss the color picker on interaction outside it, or Escape
  useEffect(() => {
    if (!colorPicker) return;
    const dismissIfOutside = (e: Event) => {
      if (colorPickerRef.current?.contains(e.target as Node)) return;
      setColorPicker(null);
    };
    const dismissOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setColorPicker(null);
    };
    // Capture phase so we fire before React Flow swallows the event
    document.addEventListener('pointerdown', dismissIfOutside, true);
    document.addEventListener('wheel', dismissIfOutside, { capture: true, passive: true });
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissIfOutside, true);
      document.removeEventListener('wheel', dismissIfOutside, { capture: true } as EventListenerOptions);
      document.removeEventListener('keydown', dismissOnEscape, true);
    };
  }, [colorPicker]);

  return (
    <div
      ref={groupRef}
      className="graph-group relative w-full h-full rounded-full pointer-events-auto"
      style={groupStyle}
      data-drop={dropHint}
      data-shared-directory={sharedDirectory ? 'true' : undefined}
      data-resizing={resizing ? 'true' : undefined}
    >
      {/* Edge handle: only the ring's stroke takes pointer events; `nodrag` stops
          React Flow from moving the group while resizing. */}
      <svg
        className="graph-group__edge nodrag nopan absolute inset-0 w-full h-full overflow-visible pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <circle
          className="graph-group__edge-ring"
          cx="50"
          cy="50"
          r="50"
          fill="none"
          stroke="transparent"
          strokeWidth="10"
          vectorEffect="non-scaling-stroke"
          pointerEvents="stroke"
          onPointerDown={handleEdgePointerDown}
          onPointerMove={handleEdgePointerMove}
          onPointerUp={handleEdgePointerUp}
          onPointerCancel={handleEdgePointerUp}
        />
      </svg>
      {/* Label pill at the top of the circle */}
      <div
        className="graph-group__label absolute left-1/2 -translate-x-1/2 -top-3 flex items-center gap-2 px-2.5 py-1 rounded-full cursor-text whitespace-nowrap"
        onDoubleClick={handleDoubleClick}
      >
        <span
          className="graph-group__swatch"
          title="Right-click to change the group color"
          onContextMenu={handleSwatchContextMenu}
          onDoubleClick={(e) => e.stopPropagation()}
        />
        {editing ? (
          <input
            ref={inputRef}
            className="bg-transparent border-none text-fg text-[10px] font-medium tracking-wide outline-none"
            style={{ width: `${Math.max(editValue.length, 4)}ch` }}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : sharedDirectory ? (
          <span className="flex flex-col leading-tight">
            <span className="text-[10px] font-medium tracking-wide">{nodeData.label}</span>
            <span className="graph-group__directory font-mono text-[9px] max-w-[260px] truncate" title={sharedDirectory}>
              {sharedDirectory}
            </span>
          </span>
        ) : (
          <span className="text-[10px] font-medium tracking-wide">{nodeData.label}</span>
        )}
      </div>

      {colorPicker && createPortal(
        <div
          ref={colorPickerRef}
          role="dialog"
          aria-label="Group color"
          className="session-node__context-menu group-color-picker"
          style={{ position: 'fixed', left: colorPicker.x, top: colorPicker.y, zIndex: 1000 }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="group-color-picker__swatches">
            {GROUP_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className="group-color-picker__swatch"
                style={{ background: swatch }}
                aria-label={`Use color ${swatch}`}
                aria-pressed={swatch.toLowerCase() === color.toLowerCase()}
                title={swatch}
                onClick={() => { pickColor(swatch); setColorPicker(null); }}
              />
            ))}
          </div>
          <label className="group-color-picker__custom">
            <input
              type="color"
              value={color}
              onChange={(e) => pickColor(e.target.value)}
            />
            <span>Custom color</span>
          </label>
        </div>,
        document.body,
      )}
    </div>
  );
});
