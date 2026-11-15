import fs from 'node:fs/promises';
import path from 'node:path';

export async function cleanupProjects(directory) {
  await fs.rm(path.join(directory, 'projects'), { recursive: true });
  return { projectsRemoved: true };
}
