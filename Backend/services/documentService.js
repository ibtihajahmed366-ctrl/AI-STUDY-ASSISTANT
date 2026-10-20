/**
 * documentService.js
 *
 * Extracts plain text from an uploaded study-material file so it can be
 * sent to the AI service. Each file type is handled by its own small
 * function; unsupported types fail loudly with a clean, honest message
 * instead of silently returning empty/wrong content.
 *
 * Text size handling
 * -------------------
 * Study material can be very long, and models have a limited context
 * window (and every extra token costs time/money). Rather than
 * implementing multi-chunk summarise-and-merge logic — which adds a lot
 * of moving parts for a beginner-friendly project — we cap the text at
 * MAX_CHARS. If the document is longer than that, we keep the first
 * ~60% and the last ~40% of the allowance (dropping the middle). This
 * is a simple, reliable, one-pass approach that still preserves the
 * most useful parts of most study material: the introduction/overview
 * (usually at the start) and the summary/conclusion (usually at the
 * end), rather than just chopping off everything after the limit.
 */

const fs = require('fs/promises');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const JSZip = require('jszip');

class ExtractionError extends Error {
  constructor(message, status = 415) {
    super(message);
    this.name = 'ExtractionError';
    this.status = status;
  }
}

// ~18,000 characters is roughly 4,000-5,000 tokens — a safe, comfortable
// amount to include alongside the system prompt/schema and still leave
// plenty of room in the model's context window for its JSON response.
const MAX_CHARS = 18000;

function truncateText(text) {
  if (text.length <= MAX_CHARS) {
    return { text, truncated: false };
  }
  const headLen = Math.floor(MAX_CHARS * 0.6);
  const tailLen = MAX_CHARS - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  return {
    text: head + '\n\n[... middle of document omitted for length ...]\n\n' + tail,
    truncated: true
  };
}

function cleanWhitespace(raw) {
  return (raw || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function finish(rawText) {
  const cleaned = cleanWhitespace(rawText);
  const { text, truncated } = truncateText(cleaned);
  return { text, truncated };
}

async function extractPdf(filePath) {
  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } catch (err) {
    console.error('[documentService] PDF parse failed:', err.message);
    throw new ExtractionError('This PDF could not be read. It may be corrupted or password-protected.', 422);
  } finally {
    await parser.destroy().catch(function () { /* ignore cleanup errors */ });
  }
}

async function extractTxt(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function extractDocx(filePath) {
  const { value } = await mammoth.extractRawText({ path: filePath });
  return value;
}

// .pptx is a zip archive of XML files. Each slide's text runs live inside
// <a:t> tags in ppt/slides/slideN.xml. jszip handles the archive; a small
// regex pulls the text runs out of each slide's XML in order. This is a
// deliberately minimal reader (not a full OOXML parser) but it reliably
// recovers the visible text of a slide deck, which is all this feature
// needs.
async function extractPptx(filePath) {
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
      return na - nb;
    });

  if (!slideFiles.length) {
    throw new ExtractionError('This PPTX file does not contain any readable slides.', 422);
  }

  const slideTexts = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async('string');
    const runs = xml.match(/<a:t>([^<]*)<\/a:t>/g) || [];
    const slideText = runs.map((r) => r.replace(/<\/?a:t>/g, '')).join(' ');
    if (slideText.trim()) slideTexts.push(slideText.trim());
  }
  return slideTexts.join('\n\n');
}

const UNSUPPORTED_MESSAGES = {
  doc: 'Text extraction for legacy .doc files is not supported yet. Please save the file as .docx or PDF and try again.',
  ppt: 'Text extraction for legacy .ppt files is not supported yet. Please save the file as .pptx or PDF and try again.',
  jpg: 'Image OCR is not currently supported.',
  jpeg: 'Image OCR is not currently supported.',
  png: 'Image OCR is not currently supported.'
};

/**
 * @param {string} filePath - path to the file on disk (e.g. from multer)
 * @param {string} originalName - original filename, used to read the extension
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
async function extractText(filePath, originalName) {
  const ext = path.extname(originalName).slice(1).toLowerCase();

  if (UNSUPPORTED_MESSAGES[ext]) {
    throw new ExtractionError(UNSUPPORTED_MESSAGES[ext], 415);
  }

  let raw;
  switch (ext) {
    case 'pdf':
      raw = await extractPdf(filePath);
      break;
    case 'txt':
      raw = await extractTxt(filePath);
      break;
    case 'docx':
      raw = await extractDocx(filePath);
      break;
    case 'pptx':
      raw = await extractPptx(filePath);
      break;
    default:
      throw new ExtractionError('Unsupported file type: .' + ext, 415);
  }

  const result = finish(raw);
  if (!result.text) {
    throw new ExtractionError('No readable text could be extracted from this file.', 422);
  }
  return result;
}

module.exports = { extractText, ExtractionError, MAX_CHARS };
