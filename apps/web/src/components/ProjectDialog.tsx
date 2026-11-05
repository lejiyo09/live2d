import { useEffect, useMemo } from 'react';
import { editor, useEditor } from '../state/editor.ts';

export function ProjectDialog() {
  const open = useEditor((s) => s.projectDialogOpen);
  const projects = useEditor((s) => s.projects);
  const thumbs = useMemo(() => new Map(projects.map((p) => [p.id, p.thumbnail ? URL.createObjectURL(p.thumbnail) : null])), [projects]);
  useEffect(() => () => { for (const u of thumbs.values()) if (u) URL.revokeObjectURL(u); }, [thumbs]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && editor.openProjectDialog(false)}>
      <div className="modal" role="dialog" aria-label="Projects">
        <header><h3>Local Projects</h3><button onClick={() => editor.openProjectDialog(false)} aria-label="Close">✕</button></header>
        {projects.length === 0 ? <p className="muted">No projects saved in this browser yet.</p> : (
          <ul className="project-list">
            {projects.map((p) => (
              <li key={p.id}>
                <button className="project-open" onClick={() => void editor.openStoredProject(p.id)}>
                  <span className="thumb">{thumbs.get(p.id) ? <img src={thumbs.get(p.id)!} alt="" /> : null}</span>
                  <span className="meta"><strong>{p.name}</strong><small>{new Date(p.updatedAt).toLocaleString()}</small></span>
                </button>
                <button className="danger" onClick={() => { if (confirm(`Delete "${p.name}" from this browser?`)) void editor.deleteStoredProject(p.id); }}>Delete</button>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Projects are stored only in this browser (IndexedDB). Export a .l2studio package to back up or move them.</p>
      </div>
    </div>
  );
}
