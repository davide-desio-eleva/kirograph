/**
 * KiroGraph — jev (TypeSafe System One) client types
 *
 * Mirrors the real API shape at https://docs.typesafe.ai:
 *   POST /v1/systemone
 *   { state: string, model: string, questions: { [id]: JevQuestion } }
 *   → { model: string, answers: { [id]: JevAnswer }, usage?: {...} }
 */

/** Choice: selects one of a fixed set of named categories. Max 255 options. */
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** category name → description shown to the model */
  criteria: Record<string, string>;
}

/** Score: a calibrated numeric level chosen from an ordered set of 2–10 descriptions. */
export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  /** ordered level descriptions, low → high */
  criteria: string[];
}

/** Noul: a boolean-shaped judgment returned as a 0.0–1.0 value. */
export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevScoreAnswer {
  type: 'score';
  score: number;
  confidence?: number;
  legend?: Record<string, string>;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
  confidence?: number;
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: JevUsage;
}
