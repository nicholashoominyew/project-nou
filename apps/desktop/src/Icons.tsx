export const iconNames=["document","book","folder","bulb","star","code","briefcase","calendar","flag","home","link","image"] as const;
const paths:Record<string,string>={
document:"M7 3h7l4 4v14H4V3h3m7 0v5h4M8 12h6M8 16h6",
book:"M12 5c-3-3-7-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-2-9 1v15",
folder:"M3 7V4h7l2 3h9v13H3V7",
bulb:"M9 18h6M9 21h6M8 14a7 7 0 1 1 8 0l-1 3H9l-1-3",
star:"m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z",
code:"m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18",
briefcase:"M8 6V3h8v3M3 6h18v15H3V6m0 6h18M10 12v3h4v-3",
calendar:"M3 5h18v16H3V5m0 5h18M7 2v6m10-6v6M7 14h2m4 0h2m-8 4h2",
flag:"M5 22V3c5-3 9 3 14 0v11c-5 3-9-3-14 0",
home:"m2 11 10-9 10 9M5 9v12h5v-7h4v7h5V9",
link:"m10 14 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
image:"M3 3h18v18H3V3m0 14 6-6 5 5 3-3 4 4M8 7h.01",
search:"m21 21-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14",
trash:"M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3",
plus:"M12 5v14M5 12h14",
compose:"M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z",
chevronLeft:"m14 6-6 6 6 6M20 6l-6 6 6 6",
menu:"M4 6h16M4 12h16M4 18h16",
archive:"M3 4h18v4H3V4m1 4v12h16V8M10 12h4",
import:"M12 3v12m0 0-4-4m4 4 4-4M4 17v4h16v-4"
};
export function Icon({name="document",size=18}:{name?:string;size?:number}){return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]||paths.document}/></svg>;}
