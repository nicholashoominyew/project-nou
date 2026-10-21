import { expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { migrateLegacy, noteSchema, FRAGMENT } from "./blockModel";
import { exportNote, parseRecovery, recoveryData } from "./noteTransfer";
it("roundtrips plain text and derives the search text instead of trusting an imported cache", () => {
  const doc = new Y.Doc(); doc.getText("body").insert(0, "脳\r\n<script>literal</script>\n");
  const data = recoveryData(doc,"text-v1","original","My note"); data.plainText = "untrusted cache";
  const parsed = parseRecovery(JSON.stringify(data));
  expect(parsed.plainText).toBe("脳\r\n<script>literal</script>\n");
  const html = exportNote(doc,"text-v1","original",'<title>',"html");
  expect(html).toContain("&lt;script&gt;literal&lt;/script&gt;"); expect(html).toContain("default-src 'none'");
  expect(html).toContain("<title>&lt;title&gt;</title>"); doc.destroy();
});
it("preserves rich formatting, Unicode, tables and original legacy text in portable JSON", () => {
  const source = new Y.Doc(); source.getText("body").insert(0,"original"); const rich = migrateLegacy(source);
  const editor = BlockNoteEditor.create(withCollaboration({ schema: noteSchema, collaboration: { fragment: rich.getXmlFragment(FRAGMENT), user: { name:"Test",color:"#000000" } } }));
  const container = document.createElement("div"); document.body.append(container); editor.mount(container);
  editor.replaceBlocks(editor.document,[{type:"heading",content:[{type:"text",text:"脳 heading",styles:{bold:true}}]},{type:"table",content:{type:"tableContent",rows:[{cells:["left","right"]}]}}]);
  const parsed = parseRecovery(exportNote(rich,"blocknote-v1","old-id","Title","json","original"));
  expect(parsed.legacyText).toBe("original"); expect(parsed.plainText).toBe("脳 heading\nleft\tright");
  const copy = new Y.Doc(); Y.applyUpdate(copy,Uint8Array.from(parsed.update));
  expect(exportNote(copy,"blocknote-v1","new-id","Title","md")).toContain("**脳 heading**");
  expect(exportNote(copy,"blocknote-v1","new-id","Title","html")).toContain("<strong>脳 heading</strong>");
  editor.unmount(); container.remove(); source.destroy(); rich.destroy(); copy.destroy();
});
it("rejects unsupported formats, missing rich fragments, invalid bytes and incomplete deltas", () => {
  const doc = new Y.Doc(); doc.getText("body").insert(0,"first");
  const data = recoveryData(doc,"text-v1","id");
  for (const changed of [{...data,format:"future"},{...data,update:[256]},{...data,update:[1.1]},{...data,editorFormat:"blocknote-v1"}]) expect(() => parseRecovery(JSON.stringify(changed))).toThrow();
  const vector = Y.encodeStateVector(doc); doc.getText("body").insert(5," later");
  expect(() => parseRecovery(JSON.stringify({...data,update:Array.from(Y.encodeStateAsUpdate(doc,vector))}))).toThrow(/incomplete/);
  doc.destroy();
});
