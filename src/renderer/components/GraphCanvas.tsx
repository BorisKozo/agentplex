import { useCallback, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useReactFlow,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { SessionNode } from './SessionNode';
import { GroupNode } from './GroupNode';
import { SubAgentNode } from './SubAgentNode';
import { DrawingOverlay } from './DrawingOverlay';
import { useAppStore } from '../store';
import { resolveDrop } from '../group-drop';

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
