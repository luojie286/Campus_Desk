// Compatibility driver for installations with the existing offline OCR models.
const fs = require('node:fs');
const path = require('node:path');
const { createWorker } = require('tesseract.js');

async function main() {
  const worker = await createWorker('chi_sim+eng', 1, {
    langPath: path.resolve('.private/ocr'),
    gzip: true,
    cacheMethod: 'none'
  });
  try {
    const result = await worker.recognize(fs.readFileSync(0));
    process.stdout.write(result.data.text);
  } finally {
    await worker.terminate();
  }
}

main().catch(() => {
  process.exitCode = 1;
});
