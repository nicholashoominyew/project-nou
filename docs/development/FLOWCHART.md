# Flowchart block

Type `/` and choose **Flowchart** to draw a process inside a note.

## Using it
- **Add step** puts a step below the lowest one and opens its text box. Press Enter or Save to keep it, Escape to cancel.
- **Click** a step to select it, **drag** it to move it, **double-click** (or F2) to rename it. With a step selected you can change its **shape** (Step, Decision diamond, Start / end) and **Delete** it. Delete or Backspace on a focused step also removes it, together with its arrows.
- **Connect**, then click the first step and the second step to draw an arrow. Click an arrow to select it, then **Label arrow** (for example "yes" and "no") or **Delete arrow**.
- **Tidy up** arranges the steps in rows, each below the steps that lead to it. It is safe on charts with loops.
- Every finished action is one undo step in the note (Ctrl+Z).
- Read-only notes show the chart without the tools.

## How it works
- The chart is stored as JSON in one prop of the block (`nouFlowchart`), so it lives in the note, syncs like any other text and is included in backups. No database change.
- `flowchart.ts` holds the data rules and every operation as pure functions. Reading is defensive: malformed JSON, unknown shapes, duplicate ids, arrows to missing steps, self-loops, huge coordinates and control characters are dropped or clamped, never thrown, so a damaged chart cannot stop a note from opening. Limits: 100 steps, 300 arrows, 100 characters per step, 40 per arrow label.
- `FlowchartView.tsx` draws plain SVG. Nothing is loaded from the web and text is only ever drawn as SVG text, never as markup.
- The step texts are added to the note's search text ("Start → Check the file → ...").

## Verified
- Vitest: 14 tests for the data rules, geometry and layout; 10 for the editor view (add, connect, self-link, shape, rename, cancel, arrow label and delete, tidy, keyboard delete, read-only, hostile text, damaged data); and 2 that insert both new blocks into the real note schema and read them back.
- Not yet verified: dragging with a real mouse, how it looks in the real window, and the slash menu entry in the real editor.

## Not built
Curved or routed arrows (arrows are straight lines), zoom and pan for very large charts, copy and paste of steps, and export to an image.
