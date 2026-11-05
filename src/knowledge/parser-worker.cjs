const path = require('node:path');

async function checkDocx(bytes) {
  const zip = await require('jszip').loadAsync(bytes);
  const files = Object.values(zip.files).filter(entry => !entry.dir);
  if (files.length > 512) throw Error('too_large');
  let total = 0;
  for (const entry of files) {
    // JSZip 的兼容流不是原生异步迭代器。逐块计量，并在超限时停止展开。
    await new Promise((resolve, reject) => {
      const stream = entry.internalStream('uint8array');
      stream.on('data', chunk => {
        total += chunk.length;
        if (total > 64 * 1024 * 1024) {
          stream.pause();
          reject(Error('too_large'));
        }
      }).on('error', reject).on('end', resolve).resume();
    });
  }
}

async function extract(name, bytes, languagePath) {
  const extension = path.extname(name).toLowerCase();
  if (extension === '.md' || extension === '.txt') {
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/);
    return lines.map((text, i) => ({ text, locator: '第 ' + (i + 1) + ' 行' }));
  }
  if (extension === '.docx') {
    await checkDocx(bytes);
    const { value } = await require('mammoth').extractRawText({ buffer: bytes });
    return value.split(/\n\n+/).map((text, i) => ({ text, locator: '第 ' + (i + 1) + ' 段' }));
  }
  let worker;
  async function ocr(image) {
    if (!worker) {
      worker = await require('tesseract.js').createWorker('chi_sim+eng', 1, {
        langPath: languagePath, cacheMethod: 'none', gzip: true
      });
    }
    return (await worker.recognize(Buffer.from(image))).data.text;
  }
  try {
    if (extension !== '.pdf') {
      // 先在解码器中取得尺寸，OCR 输入保持有界。
      const image = await require('@napi-rs/canvas').loadImage(bytes);
      if (image.width * image.height > 4000000 || Math.max(image.width, image.height) > 2000) throw Error('too_large');
      return [{ text: await ocr(bytes), locator: '图片 OCR' }];
    }
    const parser = new (require('pdf-parse').PDFParse)({ data: bytes, isEvalSupported: false, useWorkerFetch: false, verbosity: 0 });
    try {
      const info = await parser.getInfo({ parsePageInfo: true });
      if (info.total > 150) throw Error('too_large');
      const { pages } = await parser.getText();
      let scanned = 0;
      const results = [];
      for (const page of pages) {
        let body = page.text;
        let locator = '第 ' + page.num + ' 页';
        if (!body.trim()) {
          if (++scanned > 40) throw Error('too_large');
          const dimensions = info.pages.find(item => item.pageNumber === page.num);
          const scale = dimensions ? Math.min(2, 2000 / Math.max(dimensions.width, dimensions.height)) : 1;
          const shot = await parser.getScreenshot({ partial: [page.num], scale, imageDataUrl: false });
          const image = shot.pages[0];
          if (image.width * image.height > 4000000) throw Error('too_large');
          body = await ocr(image.data);
          locator += ' OCR';
        }
        results.push({ text: body, locator });
      }
      return results;
    } finally {
      await parser.destroy();
    }
  } finally {
    if (worker) await worker.terminate();
  }
}

process.once('message', async ({ name, bytes, languagePath }) => {
  try {
    const segments = await extract(name, bytes, languagePath);
    if (Buffer.byteLength(JSON.stringify(segments)) > 8 * 1024 * 1024) throw Error('too_large');
    process.send({ segments }, () => process.disconnect());
  } catch (error) {
    const code = error.message === 'too_large' ? 'too_large' : 'parse_failed';
    process.send({ code }, () => process.disconnect());
  }
});
