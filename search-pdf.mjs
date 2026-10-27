import { readFile } from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';

const search = process.argv.slice(2).join(' ').trim();

if (!search) {
  console.log('Enter a search word after the command.');
  process.exit(1);
}

let parser;

try {
  const data = await readFile('./downloaded-test.pdf');
  parser = new PDFParse({ data: new Uint8Array(data) });

  const result = await parser.getText();
  const text = result.text || '';

  if (!text.trim()) {
    console.log('No selectable text found. This PDF may need image recognition.');
  } else if (text.toLowerCase().includes(search.toLowerCase())) {
    console.log('Match found in downloaded-test.pdf');
  } else {
    console.log('No match found in downloaded-test.pdf');
  }
} catch (error) {
  console.log('Search failed:', error.message);
} finally {
  if (parser) await parser.destroy();
}