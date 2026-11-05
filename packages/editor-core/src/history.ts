import { enablePatches, produceWithPatches, applyPatches, type Patch, setAutoFreeze, current, isDraft } from 'immer';

/** Plain snapshot of an Immer draft (fast reads for heavy computations inside commands). */
export function snapshot<T>(value: T): T {
  return isDraft(value) ? (current(value as never) as T) : value;
}
import type { Project } from './model.ts';

enablePatches();
// Projects can hold thousands of nodes; freezing every revision is wasted work.
setAutoFreeze(false);

/**
 * A Command mutates an Immer draft of the project. Undo/redo is derived from
 * the recorded patches, so every command is automatically reversible.
 */
export interface Command {
  label: string;
  apply(draft: Project): void;
  /**
   * Consecutive commands with the same mergeKey (within `mergeWindowMs`) are
   * folded into one undo step — e.g. dragging an opacity slider.
   */
  mergeKey?: string;
}

interface Entry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  mergeKey?: string;
  time: number;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  /** Monotonic revision counter; changes on every execute/undo/redo/reset. */
  revision: number;
}

export class CommandHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private revision = 0;
  private listeners = new Set<(p: Project) => void>();

  constructor(
    private current: Project,
    private readonly options: { limit?: number; mergeWindowMs?: number; now?: () => number } = {},
  ) {}

  get project(): Project {
    return this.current;
  }

  get state(): HistoryState {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label,
      redoLabel: this.redoStack.at(-1)?.label,
      revision: this.revision,
    };
  }

  get labels() {
    return { undo: this.undoStack.map((e) => e.label), redo: this.redoStack.map((e) => e.label).reverse() };
  }

  subscribe(fn: (p: Project) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Replace the document and clear history (open/new project). */
  reset(project: Project) {
    this.current = project;
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  /** Returns false when the command produced no change (nothing recorded). */
  execute(cmd: Command): boolean {
    const [next, patches, inverse] = produceWithPatches(this.current, (d: Project) => {
      cmd.apply(d);
    });
    if (patches.length === 0) return false;
    const now = (this.options.now ?? Date.now)();
    const last = this.undoStack.at(-1);
    const window = this.options.mergeWindowMs ?? 800;
    if (cmd.mergeKey && last && last.mergeKey === cmd.mergeKey && now - last.time <= window && this.redoStack.length === 0) {
      last.patches = [...last.patches, ...patches];
      last.inverse = [...inverse, ...last.inverse];
      last.time = now;
    } else {
      this.undoStack.push({ label: cmd.label, patches, inverse, mergeKey: cmd.mergeKey, time: now });
      const limit = this.options.limit ?? 500;
      if (this.undoStack.length > limit) this.undoStack.splice(0, this.undoStack.length - limit);
    }
    this.redoStack = [];
    this.current = next;
    this.emit();
    return true;
  }

  /** Stop merging into the previous step (call on pointer-up / slider release). */
  sealLastStep() {
    const last = this.undoStack.at(-1);
    if (last) last.mergeKey = undefined;
  }

  undo(): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    this.current = applyPatches(this.current, e.inverse);
    this.redoStack.push(e);
    this.emit();
    return true;
  }

  redo(): boolean {
    const e = this.redoStack.pop();
    if (!e) return false;
    this.current = applyPatches(this.current, e.patches);
    this.undoStack.push({ ...e, mergeKey: undefined });
    this.emit();
    return true;
  }

  private emit() {
    this.revision++;
    for (const l of this.listeners) l(this.current);
  }
}
