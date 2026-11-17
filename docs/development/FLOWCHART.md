# Flowchart block

Type `/` and choose **Flowchart** to draw a process inside a note. The block spans the page from where the text starts to the right margin in both modes. It never covers the + and ⠿ side menu in the left margin. Inside a column or the split pane it fills that space instead.

## Two modes, switched from the ⠿ menu
Open the ⠿ menu on the flowchart and choose **Switch to view mode** or **Switch to edit mode**. The mode is saved with the block. A new flowchart starts in edit mode; a read-only note always shows view mode.

### View mode
Just the chart. No buttons, no toolbar, no panels. The whole chart is fitted to the frame and locked: it cannot be selected, dragged, renamed, panned or zoomed. Colours and line types are shown as drawn.

### Edit mode
A toolbar with three tools, **Select**, **Box** and **Connect**, plus **Tidy up** and the zoom buttons (**+**, **−**, **Fit**). A settings panel under the toolbar follows the tool.
- **Select**: click a box or an arrow to select it; drag a box to move it; double-click (or F2) to rename; Delete removes it. Drag the background to pan the canvas.
- **Box** tool: click the canvas to place a box there (it then opens its text box and you are back in Select), or press **Add box**. Panel: **Shape** (Step, Decision, Start / end), **Line** type (Solid, Dashed, Dotted, No line), **Line colour**, **Fill** colour, Rename, Delete box.
- **Connect** tool: click one box, then another, to join them; the tool stays on so you can draw several. Panel: **Shape** (Stepped or Straight), **Line** type (Solid, Dashed, Dotted), **Line colour**, **Arrowhead fill** colour (it follows the line colour unless set), an **Arrowhead** on/off switch, Label and Delete connection.
- Colours are a fixed palette (default, gray, brown, red, orange, yellow, green, blue, purple, pink). Fills are light tints that read in light and dark mode. A selected box or arrow is marked with a halo, so its own colours stay visible.
- What you pick with nothing selected is used for the next box or arrow you make. With something selected, it changes that.
- Canvas: drag the background, two-finger scroll or pinch / Ctrl+wheel to move around and zoom. Dragging a box freezes the view so the picture does not rescale.
- Every finished action is one undo step in the note (Ctrl+Z).

## Stepped arrows
Arrows are stepped by default: right angles with small rounded corners, always leaving and entering a box at the middle of a side. A box that is up and to one side of another is joined out of the side, along, and down into the top (the L shape); boxes side by side or one above the other get a step halfway; aligned boxes get one straight segment. **Straight** is a per-connection choice. The label sits halfway along. Charts made before this show their arrows stepped too (only Straight is stored).

## How it works
- The chart is JSON in one prop of the block (`nouFlowchart`), next to a `mode` prop (`edit` or `view`). No database change.
- `flowchart.ts` holds the data rules and operations as pure functions. Reading is defensive: malformed JSON, unknown shapes, colours or line types, duplicate ids, arrows to missing boxes, self-loops, huge coordinates and control characters are dropped or clamped, never thrown. A look equal to the default is not stored, so existing charts are unchanged. Limits: 100 boxes, 300 arrows, 100 characters per box, 40 per arrow label.
- `FlowchartView.tsx` draws plain SVG. Nothing is loaded from the web and text is only drawn as SVG text. Colours come from a fixed list, never from text in the note.
- The box texts are added to the note's search text ("Start → Check the file → ...").

## Verified
- Vitest: data rules, looks (kept, reset to default, dropped when invalid, plain charts store nothing), geometry, layout and camera; the editor (Box tool placing, Connect tool, Select, rename, delete, arrow labels, Tidy up); line type, line colour and fill colour on boxes and arrows, including the drawn dash patterns and colours, "No line", the arrowhead switch, tool defaults and readable text on a filled start / end box; view mode (no buttons at all, nothing can change it, colours kept, switching modes clears the editor state); the full-width rules; hostile text; and the mode prop in the real note schema.
- Not verified in the real window: the **Switch to view / edit mode** item in the ⠿ menu (BlockNote's menu cannot be opened in the test environment), dragging with a real mouse, how the panel and swatches look, and the full-width look next to your real notes.

## Not built
Arrows that route around other boxes in their way (a stepped arrow can pass behind a box that sits between two others), curved arrows, copy and paste of boxes, custom colours beyond the palette, text colour and size, and export to an image.
