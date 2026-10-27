import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const search = process.argv.slice(2).join(' ').trim();

if (!search) {
  console.log('Enter a search word after the command.');
  process.exit(1);
}

try {
  const files = await readdir('./documents');
  const jsonFiles = files.filter(file => file.endsWith('.json'));
  let matches = 0;

  for (const file of jsonFiles) {
    try {
      const content = await readFile(path.join('./documents', file), 'utf8');
      const record = JSON.parse(content);

      if ((record.text || '').toLowerCase().includes(search.toLowerCase())) {
        matches++;

        console.log(`\nMatch ${matches}`);
        console.log('Filename:', record.filename || 'Unknown');
        console.log('Chat ID:', record.chatId || 'Unknown');
        console.log(
          'Date:',
          record.timestamp
            ? new Date(record.timestamp * 1000).toLocaleString()
            : 'Unknown'
        );
        console.log('Saved PDF:', path.join('documents', record.pdfFile));
      }
    } catch (error) {
      console.log(`Could not read an index file: ${file}`);
    }
  }

  if (matches === 0) {
    console.log('No matches found.');
  } else {
    console.log(`\nTotal matches: ${matches}`);
  }
} catch (error) {
  console.log('Could not search documents:', error.message);
}