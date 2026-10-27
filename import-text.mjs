import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node import-text.mjs "path-to-file.txt"');
  process.exitCode = 1;
} else {
  await mkdir(path.join(root, 'documents'), { recursive: true });
  for (const file of files) {
    try {
      if (path.extname(file).toLowerCase() !== '.txt') throw new Error('Only .txt files are supported');
      const data = await readFile(file);
      if (data.length > 5 * 1024 * 1024) throw new Error('File exceeds 5 MB');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      const id = createHash('sha256').update('local-text\0').update(path.resolve(file)).digest('hex');
      const record = { type: 'text-file', filename: path.basename(file), chatId: 'Local file', timestamp: Math.floor(Date.now()/1000), text };
      await writeFile(path.join(root, 'documents', id + '.json'), JSON.stringify(record), 'utf8');
      console.log('Indexed:', path.basename(file));
    } catch (error) {
      console.error('Could not index file:', error.message);
      process.exitCode = 1;
    }
  }
}
