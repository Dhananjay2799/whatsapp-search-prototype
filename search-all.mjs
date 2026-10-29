import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const search = process.argv.slice(2).join(' ').trim();

if (!search) {
  console.log('Enter a search word after the command, e.g. node search-all.mjs receipt');
  process.exit(1);
}

const needle = search.toLowerCase();

function snippet(text, index, width = 60) {
  const start = Math.max(0, index - width);
  const end = Math.min(text.length, index + needle.length + width);
  return (start > 0 ? '...' : '') +
    text.slice(start, end).replace(/\s+/g, ' ').trim() +
    (end < text.length ? '...' : '');
}

try {
  const files = await readdir('./documents');
  const jsonFiles = files.filter(file => file.endsWith('.json'));
  let matches = 0;

  for (const file of jsonFiles) {
    try {
      const record = JSON.parse(await readFile(path.join('./documents', file), 'utf8'));
      const filename = record.filename || 'Unknown';
      const caption = record.caption || '';
      const text = record.text || '';

      const inName = filename.toLowerCase().includes(needle);
      const inCaption = caption.toLowerCase().includes(needle);
      const textIndex = text.toLowerCase().indexOf(needle);
      if (!inName && !inCaption && textIndex === -1) continue;

      matches++;
      const savedFile = record.savedFile || record.pdfFile;
      const foundIn = [inName && 'filename', inCaption && 'caption', textIndex !== -1 && 'text']
        .filter(Boolean)
        .join(', ');

      console.log(`\nMatch ${matches}`);
      console.log('Filename:', filename);
      console.log('Found in:', foundIn);
      console.log('Chat ID:', record.chatId || 'Unknown');
      console.log(
        'Date:',
        record.timestamp ? new Date(record.timestamp * 1000).toLocaleString() : 'Unknown'
      );
      console.log('Saved file:', savedFile ? path.resolve('documents', savedFile) : 'Unknown');
      if (textIndex !== -1) console.log('Snippet:', snippet(text, textIndex));
    } catch {
      console.log(`Could not read an index file: ${file}`);
    }
  }

  console.log(matches === 0 ? 'No matches found.' : `\nTotal matches: ${matches}`);
} catch (error) {
  console.log('Could not search documents:', error.message);
}
