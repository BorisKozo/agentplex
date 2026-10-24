import { useEffect, useState } from 'react';
import type { WorkspaceFile } from '../../shared/ipc-channels';

/** A workspace file shown as read-only plain text. */
export function ArtifactPreview({ sessionId, cwd, reference }: {
  sessionId: string; cwd: string; reference: string;
}) {
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError('');
    window.agentPlex.readWorkspaceFile(sessionId, reference)
      .then(value => { if (!cancelled) setFile(value); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [sessionId, cwd, reference, revision]);
  return (
    <section aria-label="File preview" className="h-full flex flex-col min-h-0 text-fg bg-surface">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs border-b border-border">
        <span className="truncate flex-1" title={file?.path || reference}>{file?.path || reference}</span>
        <span className="text-fg-muted">Read only</span>
        <button onClick={() => setRevision(revision + 1)} title="Reload file">Reload</button>
      </div>
      {error && <div role="alert" className="p-4 text-red-400 break-words">{error}</div>}
      {!file && !error && <div className="p-4 text-fg-muted">Loading file...</div>}
      {file && <pre className="overflow-auto p-4 text-xs whitespace-pre-wrap break-words">{file.content}</pre>}
    </section>
  );
}
