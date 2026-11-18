import {paths} from "./iconPaths";
export function Icon({name="document",size=18}:{name?:string;size?:number}){return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]||paths.document}/></svg>;}
