import os from 'node:os';
import path from 'node:path';
import { posixFilePath, validLocalName } from '../../../lib/platform/posix.mjs';

export const validName = validLocalName;
export const uploadName = name => path.posix.basename(name);
export const localPath = (value, base = os.homedir()) => path.posix.resolve(posixFilePath(base), posixFilePath(value || '.'));
export const joinPath = (directory, name) => path.posix.join(directory, name);
export const parentPath = directory => directory === path.posix.dirname(directory) ? null : path.posix.dirname(directory);
export function directoryLocation(query) {
  const atRoots = query.get('roots') === '1';
  const directory = atRoots ? '/' : localPath(query.get('path'), query.get('browse') === '1' ? query.get('base') || os.homedir() : os.homedir());
  return { path: directory, parent: parentPath(directory), atRoots: false, home: os.homedir(), roots: ['/'], os: process.platform };
}
export function uploadPath(directory, relative) {
  if (!relative || path.posix.isAbsolute(relative) || !relative.split('/').every(validName)) throw Error('文件路径无效');
  return path.posix.join(localPath(directory), relative);
}
