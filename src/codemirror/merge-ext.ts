/**
 * CodeMirror 확장: 병합 충돌 표시(<<<<<<< / ======= / >>>>>>>) 블록을 색으로 구분하고,
 * 블록 위에 현재 것 / 들어온 것 / 둘 다 버튼을 둔다 (#10 16.4). 해석은 merge-logic.ts.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { chooseLines, parseConflicts, type ConflictChoice } from '../client/merge-logic.ts';

const CHOICES: Array<{ id: ConflictChoice; label: string }> = [
  { id: 'ours', label: '현재 것' },
  { id: 'theirs', label: '들어온 것' },
  { id: 'both', label: '둘 다' },
];

/** 블록을 선택한 내용으로 바꾼다 (start 는 <<<<<<< 줄 번호) */
export function applyChoice(view: EditorView, startLine: number, choice: ConflictChoice): boolean {
  const doc = view.state.doc;
  const b = parseConflicts(doc.toString()).find((x) => x.start === startLine);
  if (!b || view.state.readOnly) return false;
  const from = doc.line(b.start).from;
  const endLine = doc.line(b.end);
  const lines = chooseLines(b, choice);
  if (lines.length) view.dispatch({ changes: { from, to: endLine.to, insert: lines.join('\n') } });
  else view.dispatch({ changes: { from, to: Math.min(doc.length, endLine.to + 1) } });
  return true;
}

class ConflictBar extends WidgetType {
  readonly startLine: number;
  readonly ours: string;
  readonly theirs: string;
  constructor(startLine: number, ours: string, theirs: string) { super(); this.startLine = startLine; this.ours = ours; this.theirs = theirs; }
  eq(o: ConflictBar) { return o.startLine === this.startLine && o.ours === this.ours && o.theirs === this.theirs; }
  toDOM(view: EditorView) {
    const bar = document.createElement('div');
    bar.className = 'cm-git-conflict-bar';
    bar.setAttribute('data-testid', 'git-conflict-bar');
    const info = document.createElement('span');
    info.textContent = `충돌: ${this.ours || '현재'} ↔ ${this.theirs || '들어온'}`;
    bar.append(info);
    for (const c of CHOICES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = c.label;
      btn.setAttribute('data-testid', 'git-conflict-' + c.id);
      btn.onmousedown = (e) => e.preventDefault();
      btn.onclick = () => {
        // 위젯이 놓인 줄 번호는 편집으로 바뀔 수 있으니 DOM 위치에서 다시 구한다
        const line = view.state.doc.lineAt(view.posAtDOM(bar)).number;
        applyChoice(view, line, c.id);
      };
      bar.append(btn);
    }
    return bar;
  }
  ignoreEvent() { return true; }
}

const lineOurs = Decoration.line({ class: 'cm-git-ours' });
const lineTheirs = Decoration.line({ class: 'cm-git-theirs' });
const lineMark = Decoration.line({ class: 'cm-git-marker' });

function build(state: EditorState): DecorationSet {
  const doc = state.doc;
  // 충돌 표시가 없는 문서(대부분)는 전체 문자열을 만들지 않는다
  let any = false;
  for (const l of doc.iterLines()) if (l.startsWith('<<<<<<<')) { any = true; break; }
  if (!any) return Decoration.none;
  const out: Range<Decoration>[] = [];
  for (const b of parseConflicts(doc.toString())) {
    out.push(Decoration.widget({ widget: new ConflictBar(b.start, b.oursLabel, b.theirsLabel), block: true, side: -1 }).range(doc.line(b.start).from));
    for (let n = b.start; n <= b.end; n++) {
      const cls = n === b.start || n === b.mid || n === b.end ? lineMark : n < b.mid ? lineOurs : lineTheirs;
      out.push(cls.range(doc.line(n).from));
    }
  }
  return Decoration.set(out, true);
}

const field = StateField.define<DecorationSet>({
  create: build,
  update: (v, tr) => (tr.docChanged ? build(tr.state) : v),
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.baseTheme({
  '.cm-git-ours': { backgroundColor: 'rgba(60, 160, 60, .14)' },
  '.cm-git-theirs': { backgroundColor: 'rgba(50, 110, 200, .14)' },
  '.cm-git-marker': { backgroundColor: 'rgba(200, 160, 0, .25)', fontWeight: '600' },
  '.cm-git-conflict-bar': { padding: '1px 6px', background: '#fff4d6', borderTop: '1px solid #e0c060', fontSize: '11px', display: 'flex', gap: '6px', alignItems: 'center' },
  '.cm-git-conflict-bar button': { fontSize: '11px', padding: '0 6px', border: '1px solid #bbb', background: '#f5f5f5', cursor: 'pointer' },
});

export function conflictExtension(): Extension {
  return [field, theme];
}
