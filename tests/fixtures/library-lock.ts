import { acquireLibraryLock } from "../../server/library-lock";
if (!process.env.LOCK_DIRECTORY) throw new Error("Missing fixture directory.");
acquireLibraryLock(process.env.LOCK_DIRECTORY);
console.log("locked");
setInterval(() => {}, 1000);
