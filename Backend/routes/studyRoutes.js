const express = require('express');
const router = express.Router();
const upload = require('../middleware/uploadMiddleware');
const { processStudyMaterial } = require('../controllers/studyController');

router.post('/process', upload.single('file'), processStudyMaterial);

module.exports = router;
