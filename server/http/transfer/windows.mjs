import os from 'node:os';
import path from 'node:path';
import { windowsFilePath, localDrives, validLocalName } from '../../../lib/platform/windows.mjs';

export const validName = validLocalName;
export const uploadName = name => name;
export const localPath = (value, base = os.homedir()) => windowsFilePath(path.win32.resolve(windowsFilePath(base), windowsFilePath(value || '.')));
export const joinPath = (directory, name) => windowsFilePath(path.win32.join(directory, name));
export const parentPath = directory => {
  const parent = windowsFilePath(path.win32.dirname(directory));
  return parent.toLowerCase() === windowsFilePath(directory).toLowerCase() ? null : parent;
};
export function directoryLocation(query) {
  const roots = localDrives().map(drive => drive + ':/'), home = windowsFilePath(os.homedir());
  if (query.get('roots') === '1') return { path: null, parent: null, atRoots: true, home, roots, os: 'win32' };
  const directory = localPath(query.get('path'), query.get('browse') === '1' ? query.get('base') || home : home);
  return { path: directory, parent: parentPath(directory), atRoots: false, home, roots, os: 'win32' };
}
export function uploadPath(directory, relative) {
  if (!relative || relative.includes('\\') || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)
      || !relative.split('/').every(validName)) throw Error('文件路径无效');
  return joinPath(localPath(directory), relative);
}
