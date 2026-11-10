import {createContext,useContext} from "react";
export type PageInfo={id:string;title:string;parent_id:string|null;sort_key:string;icon?:string;is_favorite?:boolean};
export type FileInfo={id:string;name:string;mime:string;bytes:number};
export const EditorFeatures=createContext<{pages:PageInfo[];theme:"light"|"dark";canNavigate:boolean;open:(id:string)=>void;create:()=>Promise<PageInfo>;upload:(kind:"image"|"pdf"|"file")=>Promise<FileInfo|null>;uploadFile:(file:File)=>Promise<FileInfo>;onError:(error:unknown)=>void;setPeekBusy:(busy:boolean)=>void}>({pages:[],theme:"light",canNavigate:true,open:()=>{},create:async()=>{throw Error("No page context")},upload:async()=>null,uploadFile:async()=>{throw Error("No page context")},onError:()=>{},setPeekBusy:()=>{}});
export const useEditorFeatures=()=>useContext(EditorFeatures);
