// What Vite hands back for an imported image: its URL (a data: URL when it is small).
declare module '*.svg' {
  const url: string;
  export default url;
}
