import fs from "node:fs";

export type FileIdentity = {
  dev: string;
  ino: string;
};

export function fileIdentity(stat: fs.Stats): FileIdentity | null {
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  const dev = String(stat.dev);
  const ino = String(stat.ino);
  if (dev.length === 0 || ino.length === 0 || ino === "0") return null;
  return { dev, ino };
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
