// Vite "?raw" imports return the file contents as a string (used by main.test.ts).
declare module "*?raw" { const text: string; export default text; }
