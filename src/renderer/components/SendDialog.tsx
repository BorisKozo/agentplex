import { useCallback, useEffect, useRef, useState } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { useAppStore, isSendTarget } from '../store';
import { stripAnsi } from '../../shared/ansi-strip';

const PREVIEW_MAX_CHARS = 2000;

export function SendDialog() {
  const sourceId = useAppStore((s) => s.sendDialogSourceId);
  const closeSendDialog = useAppStore((s) => s.closeSendDialog);
  const flashMessageEdge = useAppStore((s) => s.flashMessageEdge);
  const sessions = useAppStore((s) => s.sessions);
  const sessionBuffers = useAppStore((s) => s.sessionBuffers);
  const displayNames = useAppStore((s) => s.displayNames);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [instruction, setInstruction] = useState('');
  const [contextPreview, setContextPreview] = useState('');
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // All live, writable sessions except the source
  const targetSessions = Object.values(sessions).filter((s) => isSendTarget(s, sourceId));

  const sourceLabel = sourceId
    ? displayNames[sourceId] || sessions[sourceId]?.title || sourceId
    : sourceId;

  const allSelected = targetSessions.length > 0 && targetSessions.every((s) => selectedTargets.has(s.id));

  // The recent terminal output, sent as context along with the instruction
  useEffect(() => {
    if (!sourceId || !sessionBuffers[sourceId]) {
      setContextPreview('');
      return;
    }
    const stripped = stripAnsi(sessionBuffers[sourceId]);
    const tail = stripped.slice(-PREVIEW_MAX_CHARS).trim();
    setContextPreview(tail || '(no output yet)');
  }, [sourceId, sessionBuffers]);

  // Show the most recent output first: keep the preview scrolled to its end.
  useEffect(() => {
    const preview = previewRef.current;
    if (preview) preview.scrollTop = preview.scrollHeight;
  }, [contextPreview]);

  // Auto-select first target when dialog opens or targets change
  useEffect(() => {
    setSelectedTargets((prev) => {
      // Remove targets that no longer exist
      const validIds = new Set(targetSessions.map((s) => s.id));
      const cleaned = new Set([...prev].filter((id) => validIds.has(id)));
      // If nothing is selected yet and there are targets, select the first one
      if (cleaned.size === 0 && targetSessions.length > 0) {
        cleaned.add(targetSessions[0].id);
      }
      return cleaned;
    });
  }, [targetSessions.map((s) => s.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    instructionRef.current?.focus();
  }, []);

  const toggleTarget = useCallback((id: string) => {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelectedTargets(new Set());
    } else {
      setSelectedTargets(new Set(targetSessions.map((s) => s.id)));
    }
  }, [allSelected, targetSessions]);

  const handleSend = useCallback(() => {
    if (selectedTargets.size === 0 || !instruction.trim() || !sourceId) return;

    const message = [
      instruction.trim(),
      '',
      '<session_context>',
      `Context from ${sourceLabel}, another session instance of you:`,
      contextPreview,
      '</session_context>',
    ].join('\n');

    // Use bracketed paste so Claude CLI treats multi-line input as a single paste,
    // then send Enter after a generous delay so the TUI fully processes the paste.
    const bracketedPaste = `\x1b[200~${message}\x1b[201~`;

    for (const tid of selectedTargets) {
      window.agentPlex.writeSession(tid, bracketedPaste);
      const sendEnter = (targetId: string, delay: number) => {
        setTimeout(() => {
          window.agentPlex.writeSession(targetId, '\r');
        }, delay);
      };
      sendEnter(tid, 800);
      sendEnter(tid, 1500);
      sendEnter(tid, 2200);

      flashMessageEdge(sourceId, tid);
    }

    setInstruction('');
    closeSendDialog();
  }, [selectedTargets, instruction, sourceId, sourceLabel, contextPreview, closeSendDialog, flashMessageEdge]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSendDialog();
      } else if (e.key === 'Enter' && (window.agentPlex.platform === 'darwin' ? e.metaKey : e.ctrlKey)) {
        handleSend();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeSendDialog, handleSend]);

  const downPos = useRef<{ x: number; y: number } | null>(null);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      downPos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleBackdropMouseUp = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget || !downPos.current) return;
    const dx = e.clientX - downPos.current.x;
    const dy = e.clientY - downPos.current.y;
    downPos.current = null;
    if (dx * dx + dy * dy < 25) {
      closeSendDialog();
    }
  };

  const selectedCount = selectedTargets.size;
  const totalCount = targetSessions.length;
  const sendLabel = selectedCount === totalCount && totalCount > 1
    ? `Broadcast to all (${totalCount})`
    : selectedCount > 1
      ? `Send to ${selectedCount}`
      : 'Send';

  return (
    <div className="fixed inset-0 bg-backdrop flex items-center justify-center z-[1000]" onMouseDown={handleBackdropMouseDown} onMouseUp={handleBackdropMouseUp}>
      <div className="bg-elevated border border-border-strong rounded-xl p-5 w-[520px] max-w-[90vw] shadow-[0_8px_32px_var(--shadow-heavy)]">
        <div className="text-sm font-semibold text-fg mb-3.5">
          Send context from: {sourceLabel}
        </div>

        <label className="block text-xs font-medium text-fg-muted mb-1.5">To:</label>
        {targetSessions.length === 0 ? (
          <div role="status" className="py-2 px-2.5 text-[13px] text-fg-muted mb-3 bg-surface border border-border-strong rounded-lg">
            <div className="text-fg">No other active sessions</div>
            <div className="text-xs mt-0.5">Start another session with New Session, then send this context to it. Read-only monitored CLIs can't receive messages.</div>
          </div>
        ) : (
          <div className="w-full max-h-[140px] overflow-y-auto bg-surface border border-border-strong rounded-lg text-fg text-[13px] mb-3">
            <label className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border cursor-pointer hover:bg-border/30 transition-colors">
              <input
                type="checkbox"
                className="accent-accent cursor-pointer"
                checked={allSelected}
                onChange={toggleAll}
              />
              <span className="text-fg-muted text-xs font-medium">Select All</span>
            </label>
            {targetSessions.map((s) => (
              <label
                key={s.id}
                className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-border/30 transition-colors"
              >
                <input
                  type="checkbox"
                  className="accent-accent cursor-pointer"
                  checked={selectedTargets.has(s.id)}
                  onChange={() => toggleTarget(s.id)}
                />
                <span>{displayNames[s.id] || s.title}</span>
              </label>
            ))}
          </div>
        )}

        <label className="block text-xs font-medium text-fg-muted mb-1.5">Context preview:</label>
        <div ref={previewRef} className="w-full max-h-[200px] overflow-y-auto bg-inset border border-border rounded-lg text-fg-muted font-mono text-xs p-2.5 whitespace-pre-wrap break-all mb-3">
          {contextPreview || '(no output yet)'}
        </div>

        <label className="block text-xs font-medium text-fg-muted mb-1.5">Instruction:</label>
        <textarea
          ref={instructionRef}
          className="w-full bg-surface border border-border-strong rounded-lg text-fg font-mono text-[13px] p-2.5 resize-y outline-none transition-colors focus:border-accent placeholder:text-fg-muted"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. Continue this refactor, review this output..."
          rows={3}
        />


        <div className="flex justify-end gap-2 mt-3.5">
          <button className="py-1.5 px-3.5 bg-transparent border border-border-strong rounded-md text-fg text-[13px] cursor-pointer transition-colors hover:bg-border" onClick={closeSendDialog}>
            Cancel
          </button>
          <button
            className="py-1.5 px-3.5 bg-accent text-surface border-none rounded-md text-[13px] font-semibold cursor-pointer transition-colors hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSend}
            disabled={!instruction.trim() || selectedTargets.size === 0}
          >
            <span>{sendLabel}</span> <CornerDownLeft size={13} className="inline -mt-px" />
          </button>
        </div>
      </div>
    </div>
  );
}
