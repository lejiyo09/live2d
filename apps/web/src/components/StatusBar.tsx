import { useEditor } from '../state/editor.ts';

const SAVE_LABEL = { saved: 'Saved locally', dirty: 'Unsaved changes', saving: 'Saving…', error: 'Save failed', 'unsaved-new': 'New project' } as const;

export function StatusBar() {
  const cursor = useEditor((s) => s.cursor);
  const zoom = useEditor((s) => s.camera.zoom);
  const project = useEditor((s) => s.project);
  const sel = useEditor((s) => s.selection.ids.length);
  const status = useEditor((s) => s.saveStatus);
  const layers = Object.values(project.nodes).filter((n) => n.kind === 'layer').length;
  return (
    <footer className="statusbar">
      <span>{project.name}</span>
      <span>{project.canvas.width}×{project.canvas.height}</span>
      <span>{layers} layers</span>
      <span>{sel} selected</span>
      <span className="spacer" />
      <span>{cursor ? `x ${cursor.x}  y ${cursor.y}` : ''}</span>
      <span>{Math.round(zoom * 100)}%</span>
      <span className={`save save-${status}`} data-testid="save-status">{SAVE_LABEL[status]}</span>
    </footer>
  );
}
