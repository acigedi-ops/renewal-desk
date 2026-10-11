// Renewal Desk Texter app shell. It never changes, so macOS keeps its Full Disk Access and Messages permission across updates:
// the real logic is texter.js in ~/Library/Application Support/Renewal Desk Texter, re-read whenever that file changes.
ObjC.import("Foundation");
const SRC = $.NSHomeDirectory().js + "/Library/Application Support/Renewal Desk Texter/texter.js";
let T = null, stamp = "";
function mtime(){
  const a = $.NSFileManager.defaultManager.attributesOfItemAtPathError(SRC, null);
  return a.isNil() ? "" : String(a.objectForKey("NSFileModificationDate").timeIntervalSince1970);
}
function load(){
  const s = $.NSString.stringWithContentsOfFileEncodingError(SRC, $.NSUTF8StringEncoding, null);
  if (s.isNil()) throw new Error("texter.js is missing: run the installer again");
  stamp = mtime();
  return eval(s.js + "\n;({run: run, idle: idle});");
}
function run(){ T = load(); T.run(); }
function idle(){
  try { if (!T || mtime() !== stamp){ T = load(); T.run(); return 60; } } catch (e){ return 300; }
  return T.idle();
}
