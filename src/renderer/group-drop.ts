import type { Node } from '@xyflow/react';
import { useAppStore } from './store';

// Hit testing for dragging session cards onto, within and out of group circles.
// Kept out of GraphCanvas.tsx so that file only exports components (Fast Refresh).

export type DropAction =
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
