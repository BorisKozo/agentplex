import { useCallback, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useReactFlow,
  type Node,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { SessionNode } from './SessionNode';
import { GroupNode } from './GroupNode';
import { SubAgentNode } from './SubAgentNode';
import { DrawingOverlay } from './DrawingOverlay';
import { useAppStore } from '../store';

const nodeTypes = {
  sessionNode: SessionNode,
  groupNode: GroupNode,
  subagentNode: SubAgentNode,
};

export function GraphCanvas() {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const onNodesChange = useAppStore((s) => s.onNodesChange);
  const onEdgesChange = useAppStore((s) => s.onEdgesChange);
  const selectSession = useAppStore((s) => s.selectSession);
  const createGroupWithMembers = useAppStore((s) => s.createGroupWithMembers);
  const addToGroup = useAppStore((s) => s.addToGroup);
  const removeFromGroup = useAppStore((s) => s.removeFromGroup);
  const recomputeGroup = useAppStore((s) => s.recomputeGroup);
  const setGroupDragHint = useAppStore((s) => s.setGroupDragHint);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const shouldFocusNode = useAppStore((s) => s.shouldFocusNode);
  const drawingMode = useAppStore((s) => s.drawingMode);
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (!shouldFocusNode) return;
    const timer = setTimeout(() => {
      try {
        if (activePaneId) {
          fitView({ nodes: [{ id: activePaneId }], duration: 200, maxZoom: 1.5 });
        } else {
          const currentNodes = useAppStore.getState().nodes;
          if (currentNodes.length > 0) {
            fitView({ duration: 200 });
          }
        }
      } catch {
        // fitView can fail during unmount or empty graph
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [activePaneId, shouldFocusNode, fitView]);

  // Preview the drop while dragging: outline the group the session would join or leave.
  const onNodeDrag: OnNodeDrag = useCallback(
    (_event, draggedNode) => {
      const drop = resolveDrop(draggedNode);
      setGroupDragHint(drop && (drop.kind === 'join' || drop.kind === 'leave')
        ? { groupId: drop.groupId, kind: drop.kind }
        : null);
    },
    [setGroupDragHint]
  );

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, draggedNode) => {
      setGroupDragHint(null);
      const drop = resolveDrop(draggedNode);
      if (!drop) return;
      switch (drop.kind) {
        case 'leave':
          removeFromGroup(draggedNode.id);
          break;
        case 'stay':
          recomputeGroup(drop.groupId);
          break;
        case 'join':
          addToGroup(drop.groupId, draggedNode.id, { reposition: false });
          break;
        case 'pair':
          createGroupWithMembers([drop.targetId, draggedNode.id]);
          break;
      }
    },
    [createGroupWithMembers, addToGroup, removeFromGroup, recomputeGroup, setGroupDragHint]
  );

  const bumpViewportMove = useAppStore((s) => s.bumpViewportMove);

  const onPaneClick = useCallback(() => {
    selectSession(null);
  }, [selectSession]);

  const onMove = useCallback(() => {
    bumpViewportMove();
  }, [bumpViewportMove]);

  // Record pan/zoom once a move settles so it's saved with the layout, and apply a
  // saved one when the layout is restored.
  const setViewport = useAppStore((s) => s.setViewport);
  const onMoveEnd = useCallback((_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
    setViewport({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
  }, [setViewport]);

  const restoredViewport = useAppStore((s) => s.restoredViewport);
  const clearRestoredViewport = useAppStore((s) => s.clearRestoredViewport);
  const { setViewport: applyViewport } = useReactFlow();
  useEffect(() => {
    if (!restoredViewport) return;
    applyViewport(restoredViewport);
    clearRestoredViewport();
  }, [restoredViewport, applyViewport, clearRestoredViewport]);

  return (
    <div className="graph-canvas w-full h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={onPaneClick}
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        nodeTypes={nodeTypes}
        fitView
        panOnDrag={!drawingMode}
        zoomOnScroll={!drawingMode}
        zoomOnPinch={!drawingMode}
        zoomOnDoubleClick={!drawingMode}
        nodesDraggable={!drawingMode}
        nodesConnectable={!drawingMode}
        elementsSelectable={!drawingMode}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} size={1} color="var(--grid)" />
        <Panel position="top-left">
          <div className="graph-heading">
            <h1>Session map</h1>
            <span>{nodes.filter(node => node.type === 'sessionNode').length} sessions</span>
          </div>
        </Panel>
        <Controls position="bottom-right" orientation="horizontal" showInteractive={false} />
      </ReactFlow>
      <DrawingOverlay />
    </div>
  );
}

type DropAction =
  | { kind: 'leave' | 'stay' | 'join'; groupId: string }
  | { kind: 'pair'; targetId: string };

/** What releasing `draggedNode` at its current position does. Shared by the live
 *  drag preview and the drop itself so the highlight always matches the result. */
export function resolveDrop(draggedNode: Node): DropAction | null {
  // Dragging a whole group node moves its members automatically (React Flow
  // parent/child) — nothing to reconcile.
  if (draggedNode.type !== 'sessionNode') return null;

  // Use the dragged node from the callback, not the (possibly stale) store copy.
  const storeNodes = useAppStore.getState().nodes;
  const allNodes = storeNodes.map((n) => (n.id === draggedNode.id ? draggedNode : n));

  // Already in a group → either it was dragged out of the circle (leave) or
  // moved within it (stay; refit the circle).
  if (draggedNode.parentId) {
    const group = allNodes.find((n) => n.id === draggedNode.parentId);
    if (!group) return null;
    const circle = getGroupCircle(group);
    const center = childAbsoluteCenter(draggedNode, group);
    return { kind: distance(center, circle) > circle.r ? 'leave' : 'stay', groupId: group.id };
  }

  // Ungrouped node: dropped onto a group circle → join; onto another ungrouped
  // session node → form a new group.
  const draggedCenter = topLevelCenter(draggedNode);
  const draggedRect = getNodeRect(draggedNode);

  for (const targetNode of allNodes) {
    if (targetNode.id === draggedNode.id) continue;

    if (targetNode.type === 'groupNode') {
      const circle = getGroupCircle(targetNode);
      if (distance(draggedCenter, circle) <= circle.r) {
        return { kind: 'join', groupId: targetNode.id };
      }
    }

    if (targetNode.type === 'sessionNode' && !targetNode.parentId) {
      if (rectsIntersect(draggedRect, getNodeRect(targetNode))) {
        return { kind: 'pair', targetId: targetNode.id };
      }
    }
  }
  return null;
}

// Helper functions for hit testing

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Circle {
  x: number;
  y: number;
  r: number;
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;

function getNodeSize(node: Node): { width: number; height: number } {
  const anyNode = node as Node & { measured?: { width?: number; height?: number }; width?: number; height?: number };
  const styleW = typeof node.style?.width === 'number' ? node.style.width : undefined;
  const styleH = typeof node.style?.height === 'number' ? node.style.height : undefined;
  return {
    width: anyNode.measured?.width ?? anyNode.width ?? styleW ?? NODE_WIDTH,
    height: anyNode.measured?.height ?? anyNode.height ?? styleH ?? NODE_HEIGHT,
  };
}

function getNodeRect(node: Node): Rect {
  const { width, height } = getNodeSize(node);
  return { x: node.position.x, y: node.position.y, width, height };
}

/** Bounding circle of a group node (its box is a square rendered rounded-full). */
function getGroupCircle(group: Node): Circle {
  const { width } = getNodeSize(group);
  const r = width / 2;
  return { x: group.position.x + r, y: group.position.y + r, r };
}

/** Absolute centre of a child node given its parent group. */
function childAbsoluteCenter(child: Node, parent: Node): { x: number; y: number } {
  const { width, height } = getNodeSize(child);
  return {
    x: parent.position.x + child.position.x + width / 2,
    y: parent.position.y + child.position.y + height / 2,
  };
}

/** Absolute centre of a top-level node. */
function topLevelCenter(node: Node): { x: number; y: number } {
  const { width, height } = getNodeSize(node);
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 };
}

function distance(p: { x: number; y: number }, c: Circle): number {
  return Math.hypot(p.x - c.x, p.y - c.y);
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
