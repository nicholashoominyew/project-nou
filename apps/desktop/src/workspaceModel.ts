import type {PageInfo} from "./EditorContext";
export type DropPosition="before"|"inside"|"after";
export function pageDrop(pages:PageInfo[],dragged:string,target:string|null,position:DropPosition="inside"){
 const source=pages.find(p=>p.id===dragged);if(!source)throw Error("Dragged page no longer exists.");
 const to=target?pages.find(p=>p.id===target):undefined;if(target&&!to)throw Error("Destination no longer exists.");
 if(dragged===target)throw Error("A page cannot be dropped onto itself.");
 const parentId=to?(position==="inside"?to.id:to.parent_id):null;
 let ancestor=parentId;const visited=new Set<string>();while(ancestor){if(ancestor===dragged)throw Error("A page cannot be moved inside its own descendants.");if(visited.has(ancestor))throw Error("Invalid page hierarchy.");visited.add(ancestor);ancestor=pages.find(p=>p.id===ancestor)?.parent_id??null;}
 let beforeId:string|null=null;
 if(to&&position==="before")beforeId=to.id;
 if(to&&position==="after"){const siblings=pages.filter(p=>p.parent_id===to.parent_id&&p.id!==dragged).sort((a,b)=>a.sort_key.localeCompare(b.sort_key)||a.id.localeCompare(b.id));beforeId=siblings[siblings.findIndex(p=>p.id===to.id)+1]?.id??null;}
 return{pageId:dragged,parentId,beforeId};
}
