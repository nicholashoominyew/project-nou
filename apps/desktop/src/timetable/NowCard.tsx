import NowPanel from "./NowPanel";

/** Home: the same current-event panel as the Life Timetable page, with a link to open the page. */
export default function NowCard({ open }: { open?: () => void }) { return <NowPanel openTimetable={open} />; }
