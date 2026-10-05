#!/usr/bin/env node
/**
 * test/strands/mock-server.js — local stand-in for a `strands-decider serve`
 * process (https://github.com/strands-labs/strands-decider).
 *
 * Implements just enough of POST /v1/systemone to exercise KiroGraph's
 * StrandsClient end-to-end. Deliberately mirrors the jev mock's deterministic
 * dispatch (answers picked from substrings in the request `state`), so the
 * same fixtures drive both suites and the only behavioral difference under
 * test is the backend wiring — not the model's opinion.
 *
 * KEY DIFFERENCE FROM THE JEV MOCK: the real strands-decider server binds to
 * localhost and has NO authentication. This mock asserts that too — if the
 * client ever sends an Authorization header, the request is rejected with
 * 400, so the test fails loudly rather than silently passing. That pins the
 * "no auth header" contract of StrandsClient.
 *
 * Usage: node mock-server.js <port>
 */
const http = require('http');

const port = parseInt(process.argv[2] || '8843', 10);

// Ordered [substring, answer] rules per question id. First match wins;
// falls through to a neutral default if nothing matches. Mirrors the jev mock.
const RULES = {
  relation: [
    ['Redis-backed session storage', { choice: 'supersedes', confidence: 0.92 }],
    ['centralized logger utility', { choice: 'related', confidence: 0.4 }],
  ],
  contradicts: [
    ['JWT was removed', { noul: 0.88, confidence: 0.88 }],
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
  if (type === 'choice') {
    const first = Object.keys(criteria || {})[0] ?? 'related';
    return { type, choice: first, confidence: 0.5 };
  }
  return { type, noul: 0.5, confidence: 0.5 };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'strands-decider-mock', device: 'cpu' }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/v1/systemone') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  // Contract check: strands-decider has no auth. The client must NOT send an
  // Authorization header. If it does, fail hard — this is a wiring bug.
  if (req.headers['authorization']) {
    console.log(`REJECT unexpected Authorization header: ${req.headers['authorization']}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'strands-decider is unauthenticated; no Authorization header expected' }));
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

    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      answers[id] = answerFor(id, q.type, state, q.criteria);
    }

    console.log(`REQ ${Object.keys(questions).join(',')} -> ${JSON.stringify(answers)}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: model || 'strands-decider-mock',
      answers,
      usage: { input_tokens: state.length, output_tokens: 8 },
    }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`strands-decider mock server listening on 127.0.0.1:${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
