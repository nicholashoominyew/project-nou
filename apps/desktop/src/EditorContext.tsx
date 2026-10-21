import {createContext,useContext} from "react";
export type PageInfo={id:string;title:string;parent_id:string|null;sort_key:string;icon?:string};
export type FileInfo={id:string;name:string;mime:string;bytes:number};
export const EditorFeatures=createContext<{pages:PageInfo[];theme:"light"|"dark";canNavigate:boolean;open:(id:string)=>void;create:()=>Promise<PageInfo>;upload:(kind:"image"|"pdf")=>Promise<FileInfo|null>;onError:(error:unknown)=>void}>({pages:[],theme:"light",canNavigate:true,open:()=>{},create:async()=>{throw Error("No page context")},upload:async()=>null,onError:()=>{}});
export const useEditorFeatures=()=>useContext(EditorFeatures);
