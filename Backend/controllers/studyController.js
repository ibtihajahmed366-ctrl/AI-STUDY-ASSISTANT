const fs = require('fs');
const { extractText } = require('../services/documentService');
const { generateStudyContent, VALID_TYPES } = require('../services/aiService');

function cleanup(filePath) {
  if (filePath) fs.unlink(filePath, function () { /* best-effort cleanup */ });
}

/**
 * POST /api/study/process
 * multipart/form-data: file, type
 */
async function processStudyMaterial(req, res, next) {
  const filePath = req.file && req.file.path;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file was uploaded.' });
    }
    if (req.file.size === 0) {
      return res.status(400).json({ success: false, error: 'The uploaded file is empty.' });
    }

    const type = req.body.type;
    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing "type". Must be one of: ' + VALID_TYPES.join(', ') + '.'
      });
    }

    const { text, truncated } = await extractText(req.file.path, req.file.originalname);

    const data = await generateStudyContent({ text: text, type: type });

    const responseBody = { success: true, type: type, data: data };
    if (truncated) {
      responseBody.warning = 'This document was long, so only part of it (the beginning and end) was used to generate this result.';
    }
    return res.json(responseBody);
  } catch (err) {
    return next(err);
  } finally {
    cleanup(filePath);
  }
}

module.exports = { processStudyMaterial };
