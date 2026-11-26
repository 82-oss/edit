// `edit`: the command (cli.ts). A dev run is `bun apps/server/src/main.ts serve`;
// the release binary's entry is the generated `embedded.gen.ts`, which
// registers the files it carries and then imports this. Either way argv is
// [bun, <script>, …the arguments].

const args = process.argv.slice(2);
// An effect render's frames, drawn by a process of their own that loads nothing else of the server (frame_capture.ts).
if (args[0] === "capture-frames") await (await import("./frame_capture.ts")).run();
else await (await import("./cli.ts")).main(args);
