export * from "./sync-player-data.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "./sync-player-data.mjs";

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
