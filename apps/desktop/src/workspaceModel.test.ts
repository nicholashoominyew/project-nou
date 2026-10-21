import {expect,it} from "vitest";
import {pageDrop} from "./workspaceModel";
const pages=[{id:"a",title:"A",parent_id:null,sort_key:"001"},{id:"b",title:"B",parent_id:null,sort_key:"002"},{id:"c",title:"C",parent_id:"a",sort_key:"001"}];
it("plans nesting, root moves and sibling insertion",()=>{expect(pageDrop(pages,"b","a","inside")).toEqual({pageId:"b",parentId:"a",beforeId:null});expect(pageDrop(pages,"c",null)).toEqual({pageId:"c",parentId:null,beforeId:null});expect(pageDrop(pages,"c","a","after")).toEqual({pageId:"c",parentId:null,beforeId:"b"});});
it("rejects self moves and cycles before sending a native mutation",()=>{expect(()=>pageDrop(pages,"a","c","inside")).toThrow(/descendants/);expect(()=>pageDrop(pages,"a","a","before")).toThrow(/itself/);});
