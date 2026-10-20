require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const studyRoutes = require('./routes/studyRoutes');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get('/api/health', function (req, res) {
  res.json({ status: 'ok' });
});

app.use('/api/study', studyRoutes);

// 404 for anything else under /api
app.use('/api', function (req, res) {
  res.status(404).json({ success: false, error: 'Not found.' });
});

// Convenience: if a Frontend folder sits next to this Backend folder, serve it
// too, so you can simply open http://localhost:5000 (no Live Server needed).
const FRONTEND_DIR = ['Frontend', 'frontend']
  .map(function (name) { return path.join(__dirname, '..', name); })
  .find(function (dir) { return fs.existsSync(dir); });
if (FRONTEND_DIR) {
  app.use(express.static(FRONTEND_DIR));
}

// Centralized error handler — must be registered last.
app.use(errorHandler);

app.listen(PORT, function () {
  console.log('AI Study Assistant backend running on http://localhost:' + PORT);
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('WARNING: OPENROUTER_API_KEY is not set. Add it to backend/.env (see .env.example).');
  }
});
