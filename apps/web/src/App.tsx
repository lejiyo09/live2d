import { useCallback, useEffect, useState } from 'react';
import { MenuBar } from './components/MenuBar.tsx';
import { LayerTree } from './components/LayerTree.tsx';
import { Workspace } from './components/Workspace.tsx';
import { Inspector } from './components/Inspector.tsx';
import { BottomPanel } from './components/BottomPanel.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { ProjectDialog } from './components/ProjectDialog.tsx';
import { AutoMeshDialog } from './components/AutoMeshDialog.tsx';
import { DeformerDialog } from './components/DeformerTree.tsx';
import { AssistantDialog, AutoRigDialog, RecognizeDialog } from './components/AiDialogs.tsx';
import { ExportDialog } from './components/ExportDialog.tsx';
import { Moc3Preview } from './components/Moc3Preview.tsx';
import { PreferencesDialog, applyPrefs } from './components/Preferences.tsx';
import { SegmentDialog } from './components/SegmentDialog.tsx';

applyPrefs();
import { Splitter } from './components/Splitter.tsx';
import { editor, useEditor } from './state/editor.ts';
import { installShortcuts } from './state/shortcuts.ts';

interface Layout { left: number; right: number; bottom: number }
const DEFAULT_LAYOUT: Layout = { left: 280, right: 300, bottom: 180 };

function loadLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem('l2s:layout') ?? '{}') };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function App() {
  const [layout, setLayout] = useState(loadLayout);
  useEffect(() => {
    try { localStorage.setItem('l2s:layout', JSON.stringify(layout)); } catch { /* storage unavailable */ }
  }, [layout]);
  useEffect(installShortcuts, []);

  const onReady = useCallback(() => {
    const params = new URLSearchParams(location.search);
    const demo = import.meta.env.VITE_DEMO === '1';
    if (params.has('sample') || location.hash === '#sample') void editor.openSample();
    else if (!params.has('fresh')) void editor.restoreLastSession().then(() => {
      // Hosted demo: start with the sample character instead of an empty canvas.
      if (demo && !useEditor.getState().project.rootIds.length) void editor.openSample();
    });
    // PWA file handling (launch with a .psd / .l2studio file).
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async ({ files }) => {
      const h = files[0];
      if (h) void editor.openFile(await h.getFile());
    });
  }, []);

  const set = (k: keyof Layout) => (v: number) => setLayout((l) => ({ ...l, [k]: v }));

  return (
    <div
      className="app"
      style={{ gridTemplateColumns: `${layout.left}px 4px 1fr 4px ${layout.right}px`, gridTemplateRows: `auto 1fr 4px ${layout.bottom}px auto` }}
    >
      <div className="area-menu"><MenuBar /></div>
      <div className="area-left"><LayerTree /></div>
      <div className="area-split-l"><Splitter axis="x" value={layout.left} onChange={set('left')} min={180} max={560} /></div>
      <div className="area-center"><Workspace onReady={onReady} /></div>
      <div className="area-split-r"><Splitter axis="x" value={layout.right} onChange={set('right')} min={220} max={560} sign={-1} /></div>
      <div className="area-right"><Inspector /></div>
      <div className="area-split-b"><Splitter axis="y" value={layout.bottom} onChange={set('bottom')} min={60} max={520} sign={-1} /></div>
      <div className="area-bottom"><BottomPanel /></div>
      <div className="area-status"><StatusBar /></div>
      <ProjectDialog />
      <AutoMeshDialog />
      <DeformerDialog />
      <RecognizeDialog />
      <AutoRigDialog />
      <AssistantDialog />
      <ExportDialog />
      <Moc3Preview />
      <PreferencesDialog />
      <SegmentDialog />
    </div>
  );
}
