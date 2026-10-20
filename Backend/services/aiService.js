/**
 * aiService.js
 *
 * Talks to OpenRouter and turns a model's reply into clean, validated
 * JSON in the exact shape the frontend's render functions expect.
 * The OpenRouter API key never leaves this file's requests to
 * OpenRouter — it is never logged and never included in any response
 * sent back to the browser.
 */

const SYSTEM_PROMPT = [
  'You are an educational AI Study Assistant.',
  '',
  'Use only the information contained in the supplied study material.',
  'Do not invent facts.',
  'Do not add unrelated information.',
  'If something is not present in the material, do not pretend it is.',
  'Make explanations clear and student-friendly.',
  'Generate accurate study material.',
  '',
  'Return ONLY valid JSON matching the requested schema.',
  'Do not use markdown fences.',
  'Do not add commentary outside the JSON.'
].join('\n');

// One instruction block per study feature. Each describes the exact JSON
// shape to return — these match the schemas the frontend already renders.
const PROMPTS = {
  summary:
    'Generate a study summary from the material below. Return JSON exactly in this shape:\n' +
    '{"topic": "string", "summary": {"overview": "string", "mainTopics": ["string"], "detailed": ["string"], "takeaways": ["string"]}}\n' +
    '"mainTopics" should list 3-6 key topics. "detailed" should be 2-4 paragraphs as separate array items. "takeaways" should list 4-6 concise bullet points.',
  questions:
    'Generate important study questions with answers from the material below. Return JSON exactly in this shape:\n' +
    '{"topic": "string", "questions": [{"topic": "string", "difficulty": "easy", "q": "string", "a": "string"}]}\n' +
    'Generate 5 to 8 questions. "difficulty" must be exactly one of "easy", "medium" or "hard", and use a mix of all three across the set.',
  mcq:
    'Generate multiple-choice questions from the material below. Return JSON exactly in this shape:\n' +
    '{"topic": "string", "mcqs": [{"q": "string", "options": ["string", "string", "string", "string"], "correct": 0, "explain": "string"}]}\n' +
    'Generate 4 to 6 questions. Each must have EXACTLY four options. "correct" is the zero-based index (0, 1, 2 or 3) of the right option. "explain" must justify the correct answer using only the supplied material.',
  quiz:
    'Generate an interactive quiz from the material below. Return JSON exactly in this shape:\n' +
    '{"topic": "string", "quiz": [{"q": "string", "options": ["string", "string", "string", "string"], "correct": 0}]}\n' +
    'Generate exactly 5 questions. Each must have EXACTLY four options and a zero-based "correct" index.',
  flashcards:
    'Generate flashcards from the material below. Return JSON exactly in this shape:\n' +
    '{"topic": "string", "flashcards": [{"front": "string", "back": "string"}]}\n' +
    'Generate 6 to 10 cards. "front" is a concept or question; "back" is a concise explanation or answer.',
  keypoints:
    'Generate the most important points from the material below. Return JSON exactly in this shape:\n' +
    '{"topic": "string", "keypoints": ["string"]}\n' +
    'Generate 5 to 8 points, ordered by importance.'
};

function buildUserMessage(type, text) {
  return PROMPTS[type] + '\n\nStudy material:\n"""\n' + text + '\n"""';
}

/** Short, safe, actionable messages for the most common OpenRouter errors. */
function friendlyProviderMessage(status) {
  if (status === 429) {
    return 'The free AI model is busy or its request limit was reached. Please wait a minute or two and try once more (clicking repeatedly can use up your daily free limit).';
  }
  if (status === 401) {
    return 'OpenRouter rejected the API key. Check OPENROUTER_API_KEY in backend/.env and restart the server.';
  }
  if (status === 402) {
    return 'OpenRouter reports a credit/balance problem on this account.';
  }
  if (status === 404) {
    return 'OpenRouter could not find an available endpoint for this model. Check OPENROUTER_MODEL in backend/.env, or your OpenRouter privacy settings for free models.';
  }
  return 'The AI provider could not process this request. Please try again in a moment.';
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Optional: comma-separated backup models. If the main model is rate-limited
// or down, OpenRouter itself automatically tries these in order.
function getFallbackModels() {
  return (process.env.OPENROUTER_FALLBACK_MODELS || '')
    .split(',')
    .map(function (m) { return m.trim(); })
    .filter(Boolean);
}

/** Pulls the text out of an OpenRouter reply (content may be a string or a list of parts). */
function readReply(payload) {
  const choice = payload && payload.choices && payload.choices[0];
  const message = choice && choice.message;
  let content = message && message.content;
  if (Array.isArray(content)) {
    content = content
      .map(function (part) { return part && typeof part.text === 'string' ? part.text : ''; })
      .join('');
  }
  return {
    content: typeof content === 'string' ? content.trim() : '',
    finishReason: choice && choice.finish_reason,
    reasoningChars: message && typeof message.reasoning === 'string' ? message.reasoning.length : 0,
    modelUsed: payload && payload.model
  };
}

/** Sends one request to OpenRouter and returns the parsed reply. */
async function requestOnce(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;

  if (!apiKey) {
    const err = new Error('The server is missing its OpenRouter API key. Add OPENROUTER_API_KEY to backend/.env.');
    err.status = 500;
    throw err;
  }
  if (!model) {
    const err = new Error('The server is missing OPENROUTER_MODEL. Add it to backend/.env.');
    err.status = 500;
    throw err;
  }

  const body = { model: model, messages: messages, temperature: 0.4 };
  const fallbacks = getFallbackModels();
  if (fallbacks.length) body.models = fallbacks;

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (networkErr) {
    console.error('[aiService] Network error calling OpenRouter:', networkErr.message);
    const err = new Error('Could not reach the AI provider. Please check your connection and try again.');
    err.status = 502;
    throw err;
  }

  if (!response.ok) {
    let detail = '';
    let providerNote = '';
    try {
      const errBody = await response.json();
      const e = (errBody && errBody.error) || {};
      detail = e.message || '';
      const meta = e.metadata || {};
      providerNote = [meta.provider_name, typeof meta.raw === 'string' ? meta.raw.slice(0, 300) : '']
        .filter(Boolean)
        .join(': ');
    } catch (_) {
      /* response body wasn't JSON; ignore */
    }
    // Full detail is logged server-side only — never sent to the browser.
    console.error('[aiService] OpenRouter responded with', response.status, detail, providerNote);
    const err = new Error(friendlyProviderMessage(response.status));
    err.status = response.status === 429 ? 429 : 502;
    throw err;
  }

  return readReply(await response.json());
}

function logEmptyReply(reply, note) {
  console.error(
    '[aiService] Empty reply from model "' + reply.modelUsed + '" (finish_reason: ' + reply.finishReason +
    ', reasoning characters: ' + reply.reasoningChars + '). ' + note
  );
}

/**
 * Free models sometimes answer HTTP 200 with no text at all. That is usually
 * a one-off glitch, so we try exactly one more time before giving up.
 */
async function callOpenRouter(messages) {
  let reply = await requestOnce(messages);

  if (!reply.content) {
    logEmptyReply(reply, 'Retrying once...');
    await sleep(1500);
    reply = await requestOnce(messages);
  }

  if (!reply.content) {
    logEmptyReply(reply, 'Giving up.');
    const err = new Error('The AI model sent back an empty reply twice. Wait a minute and try again, or change OPENROUTER_MODEL in backend/.env to a different model.');
    err.status = 502;
    throw err;
  }
  return reply.content;
}

/** Strips markdown fences / stray text around the JSON object and parses it. */
function extractJson(raw) {
  let cleaned = String(raw).trim();

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('[aiService] Failed to parse AI response as JSON:', parseErr.message, '| reply starts with:', JSON.stringify(cleaned.slice(0, 200)));
    const err = new Error('The AI returned a response that could not be read. Please try again.');
    err.status = 502;
    throw err;
  }
}

function invalid(detail) {
  const err = new Error('The AI response did not match the expected format (' + detail + '). Please try again.');
  err.status = 502;
  throw err;
}

/** Validates (and lightly repairs) the parsed JSON against the schema for `type`. */
function validateShape(type, parsed) {
  if (!parsed || typeof parsed !== 'object') invalid('not a JSON object');
  if (typeof parsed.topic !== 'string' || !parsed.topic.trim()) invalid('missing topic');

  if (type === 'summary') {
    const s = parsed.summary;
    if (!s || typeof s !== 'object') invalid('missing summary');
    if (typeof s.overview !== 'string') invalid('missing summary.overview');
    if (!Array.isArray(s.mainTopics) || !s.mainTopics.length) invalid('missing summary.mainTopics');
    if (!Array.isArray(s.detailed) || !s.detailed.length) invalid('missing summary.detailed');
    if (!Array.isArray(s.takeaways) || !s.takeaways.length) invalid('missing summary.takeaways');
  } else if (type === 'questions') {
    if (!Array.isArray(parsed.questions) || !parsed.questions.length) invalid('missing questions');
    parsed.questions.forEach(function (q, i) {
      if (typeof q.q !== 'string' || typeof q.a !== 'string') invalid('question ' + i + ' is malformed');
      if (!['easy', 'medium', 'hard'].includes(q.difficulty)) q.difficulty = 'medium';
      if (typeof q.topic !== 'string') q.topic = parsed.topic;
    });
  } else if (type === 'mcq') {
    if (!Array.isArray(parsed.mcqs) || !parsed.mcqs.length) invalid('missing mcqs');
    parsed.mcqs.forEach(function (m, i) {
      if (typeof m.q !== 'string') invalid('mcq ' + i + ' is missing its question');
      if (!Array.isArray(m.options) || m.options.length !== 4) invalid('mcq ' + i + ' must have exactly 4 options');
      if (!Number.isInteger(m.correct) || m.correct < 0 || m.correct > 3) invalid('mcq ' + i + ' has an invalid correct index');
      if (typeof m.explain !== 'string') m.explain = '';
    });
  } else if (type === 'quiz') {
    if (!Array.isArray(parsed.quiz) || !parsed.quiz.length) invalid('missing quiz');
    parsed.quiz.forEach(function (q, i) {
      if (typeof q.q !== 'string') invalid('quiz question ' + i + ' is missing its question');
      if (!Array.isArray(q.options) || q.options.length !== 4) invalid('quiz question ' + i + ' must have exactly 4 options');
      if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) invalid('quiz question ' + i + ' has an invalid correct index');
    });
  } else if (type === 'flashcards') {
    if (!Array.isArray(parsed.flashcards) || !parsed.flashcards.length) invalid('missing flashcards');
    parsed.flashcards.forEach(function (c, i) {
      if (typeof c.front !== 'string' || typeof c.back !== 'string') invalid('flashcard ' + i + ' is malformed');
    });
  } else if (type === 'keypoints') {
    if (!Array.isArray(parsed.keypoints) || !parsed.keypoints.length) invalid('missing keypoints');
    parsed.keypoints.forEach(function (p, i) {
      if (typeof p !== 'string') invalid('key point ' + i + ' is not text');
    });
  }

  return parsed;
}

const VALID_TYPES = Object.keys(PROMPTS);

/**
 * @param {{ text: string, type: string }} params
 * @returns {Promise<object>} JSON matching the schema for `type`
 */
async function generateStudyContent(params) {
  const text = params && params.text;
  const type = params && params.type;

  if (!text || !String(text).trim()) {
    const err = new Error('No study material text was provided.');
    err.status = 422;
    throw err;
  }
  if (!VALID_TYPES.includes(type)) {
    const err = new Error('Unsupported study type: ' + type);
    err.status = 400;
    throw err;
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(type, text) }
  ];

  const raw = await callOpenRouter(messages);
  const parsed = extractJson(raw);
  return validateShape(type, parsed);
}

module.exports = { generateStudyContent, VALID_TYPES };
