#!/usr/bin/env node
/**
 * test/jev/mock-server.js — local stand-in for https://api.typesafe.ai
 *
 * Implements just enough of POST /v1/systemone to exercise KiroGraph's jev
 * client end-to-end (request shape, auth header, error handling) without a
 * real API key or network access. Answers are picked deterministically from
 * substrings in the request `state`, so each test scenario's fixture content
 * IS the mock's dispatch key — no artificial out-of-band markers.
 *
 * Usage: node mock-server.js <port> <expectedApiKey>
 * Logs one line per request to stdout: "REQ <question-ids> -> <answer-summary>"
 */
const http = require('http');

const port = parseInt(process.argv[2] || '8842', 10);
const expectedApiKey = process.argv[3] || 'mock-jev-key';

// Ordered [substring, answer] rules per question id. First match wins;
// falls through to a neutral default if nothing matches.
const RULES = {
  relation: [
    ['Redis-backed session storage', { choice: 'supersedes', confidence: 0.92 }],
    ['centralized logger utility', { choice: 'related', confidence: 0.4 }],
  ],
  contradicts: [
    ['JWT was removed', { noul: 0.88, confidence: 0.88 }],
    // No rule for the payment-flow/payment-webhooks pair — falls through to
    // the neutral default below threshold, representing a genuine "no
    // contradiction" judgment rather than a hardcoded negative.
  ],
  authenticated: [
    ['/api/profile', { noul: 0.85, confidence: 0.85 }],
    ['/public/health', { noul: 0.1, confidence: 0.1 }],
  ],
};

function answerFor(id, type, state, criteria) {
  const rules = RULES[id] || [];
  for (const [needle, answer] of rules) {
    if (state.includes(needle)) {
      if (type === 'choice') return { type, choice: answer.choice, confidence: answer.confidence };
      return { type, noul: answer.noul, confidence: answer.confidence };
    }
  }
  // Neutral default — keeps unrecognized fixtures from crashing the server,
  // but should not satisfy any test's assertions (all real test cases match a rule above).
  if (type === 'choice') {
    const first = Object.keys(criteria || {})[0] ?? 'related';
    return { type, choice: first, confidence: 0.5 };
  }
  return { type, noul: 0.5, confidence: 0.5 };
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/systemone') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  const key = auth.replace(/^Bearer\s+/i, '');
  if (key !== expectedApiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid API key' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }

    const { state, model, questions } = parsed;
    if (typeof state !== 'string' || typeof questions !== 'object' || questions === null) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing state or questions' }));
      return;
    }

    // Deliberate failure injection for the error-path test, without a real 4xx/5xx code path.
    if (state.includes('MOCKJEV_FORCE_500')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error (forced by test)' }));
      return;
    }

    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      answers[id] = answerFor(id, q.type, state, q.criteria);
    }

    console.log(`REQ ${Object.keys(questions).join(',')} -> ${JSON.stringify(answers)}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: model || 'jev-mock',
      answers,
      usage: { input_tokens: state.length, output_tokens: 8 },
    }));
  });
});

server.listen(port, () => {
  console.log(`jev mock server listening on :${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
