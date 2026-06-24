/**
 * wordsmith -- Fast-paced word game powered by jobs-algo.
 *
 * Each round generates a prompt (word puzzle, riddle, or story hook),
 * the player guesses, and the system validates + scores.
 * Jobs are split into urgency buckets:
 *   - word-prompt (5s): generates the challenge (most urgent)
 *   - word-validate (10s): checks if the answer is correct
 *   - word-hint (15s): generates a hint if the player is stuck
 *   - word-score (8s): computes points and updates the leaderboard
 *
 * Run:
 *   npx tsx examples/wordsmith/wordsmith.ts --rounds 10 --difficulty easy
 *   npx tsx examples/wordsmith/wordsmith.ts --rounds 10 --difficulty hard
 */

import { JobsAlgorithmImpl } from '../../src/integration/jobs-algorithm.js';
import { OllamaDirectExecutor } from '../../src/integration/ollama/ollama-executor.js';
import { computeSignature } from '../../src/algorithm/signature.js';
import type { AlgorithmEvent, Signature } from '../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../src/types/index.js';
import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';

// ── Difficulty presets ──

interface GameDifficulty {
  label: string;
  rounds: number;
  promptUrgency: number;
  validateUrgency: number;
  hintUrgency: number;
  scoreUrgency: number;
  promptPrompt: string;
  validatePrompt: string;
  hintPrompt: string;
  scorePrompt: string;
  timeLimitSec: number;
}

const DIFFICULTIES: Record<string, GameDifficulty> = {
  easy: {
    label: 'Easy',
    rounds: 10,
    promptUrgency: 5_000,
    validateUrgency: 10_000,
    hintUrgency: 15_000,
    scoreUrgency: 8_000,
    promptPrompt: 'Generate a simple word game challenge. Pick a category (animals, colors, foods, countries) and give 3 hints that get progressively more specific. Format: Category: <cat>\\nHint 1: <vague>\\nHint 2: <medium>\\nHint 3: <specific>\\nAnswer: <word>',
    validatePrompt: 'The player guessed: "{guess}" for the word game challenge: "{challenge}". Is the guess correct? Answer ONLY "CORRECT" or "WRONG" followed by the correct answer if wrong.',
    hintPrompt: 'For the word game challenge: "{challenge}", give one additional hint that does not reveal the answer directly. Be clever and concise.',
    scorePrompt: 'In a word game, the player guessed "{guess}" for challenge: "{challenge}". The correct answer was "{answer}". Rate the guess on a scale of 1-10 for creativity and closeness. Reply with just a number.',
    timeLimitSec: 30,
  },
  hard: {
    label: 'Hard',
    rounds: 10,
    promptUrgency: 3_000,
    validateUrgency: 6_000,
    hintUrgency: 8_000,
    scoreUrgency: 5_000,
    promptPrompt: 'Generate a difficult word puzzle or riddle. It should require lateral thinking or knowledge of obscure words. Format: Puzzle: <riddle>\\nAnswer: <word>',
    validatePrompt: 'The player guessed: "{guess}" for the word puzzle: "{challenge}". Is the guess correct? Be strict - only exact matches or very close synonyms count. Answer ONLY "CORRECT" or "WRONG" followed by the answer if wrong.',
    hintPrompt: 'For the word puzzle: "{challenge}", give a subtle hint that requires thinking. Do NOT reveal the answer. Be cryptic and clever.',
    scorePrompt: 'In a hard word puzzle game, the player guessed "{guess}" for challenge: "{challenge}". The correct answer was "{answer}". Rate creativity 1-10 even if wrong. Reply with just a number.',
    timeLimitSec: 20,
  },
};

// ── Game structures ──

interface RoundResult {
  round: number;
  challenge: string;
  answer: string;
  playerGuess: string;
  correct: boolean;
  score: number;
  wallMs: number;
}

interface GameReport {
  difficulty: string;
  timestamp: string;
  rounds: RoundResult[];
  totalScore: number;
  correctCount: number;
  totalRounds: number;
  wallMs: number;
  profileSnapshots: Array<{ name: string; sampleCount: number; warm: boolean; wallEWMA: number }>;
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      parsed[key] = value;
      if (value !== 'true') i++;
    }
  }
  return parsed;
}

async function runGame(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const difficultyName = String(args.difficulty || 'easy').toLowerCase();
  const diff = DIFFICULTIES[difficultyName];
  if (!diff) {
    console.error('Unknown difficulty: ' + difficultyName + '. Use "easy" or "hard".');
    process.exit(1);
  }
  const roundCount = Number(args.rounds || diff.rounds);
  const slots = Number(args.slots || 3);
  const model = String(args.model || 'qwen2.5:0.5b');
  const outputDir = String(args.output || '.cache/wordsmith');
  const autoMode = args.auto === 'true' || args.auto === '1';

  console.log('');
  console.log('='.repeat(60));
  console.log('  WORDSMITH -- ' + diff.label.toUpperCase() + ' MODE');
  console.log('  Rounds: ' + roundCount + '  |  Slots: ' + slots + '  |  Model: ' + model);
  console.log('  Time limit: ' + diff.timeLimitSec + 's per round');
  console.log('='.repeat(60));
  console.log('');

  const config: Partial<typeof DEFAULT_CONFIG> = {
    ...DEFAULT_CONFIG,
    maxParallelism: slots,
    defaultCacheExpiryMs: 30_000,
    defaultRefreshRateMs: 300_000,
    coldStartSamples: 2,
    cacheDir: path.join(outputDir, 'cache'),
  };

  const algo = new JobsAlgorithmImpl(config);
  algo.setMissionControl(new OllamaDirectExecutor({
    model,
    timeoutMs: 30_000,
    maxTokens: 80,
  }));

  // Signatures
  const promptSig = computeSignature({ type: 'word-prompt', entity: 'game', argSchema: { difficulty: 'string', round: 'string' } });
  const validateSig = computeSignature({ type: 'word-validate', entity: 'game', argSchema: { guess: 'string', challenge: 'string' } });
  const hintSig = computeSignature({ type: 'word-hint', entity: 'game', argSchema: { challenge: 'string' } });
  const scoreSig = computeSignature({ type: 'word-score', entity: 'game', argSchema: { guess: 'string', answer: 'string', challenge: 'string' } });

  const results: RoundResult[] = [];
  const rl = autoMode ? null : readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('  Starting game... Generating challenges in parallel.');
  console.log('  The scheduler prioritizes prompt generation (lowest urgency) first.');
  console.log('');

  // Generate all prompts up front in parallel (urgency ordering will schedule them)
  const promptJobs: Array<{ jobId: string; round: number; resolve: (result: string) => void; reject: (err: Error) => void }> = [];

  for (const sig of [promptSig, validateSig, hintSig, scoreSig]) {
    algo.subscribe(sig, (event: AlgorithmEvent) => {
      // Results collected per-job via promises below
    });
  }

  // Play rounds
  let totalScore = 0;
  let correctCount = 0;
  const startTime = Date.now();

  for (let round = 1; round <= roundCount; round++) {
    // Generate challenge
    const challengePayload = Buffer.from(JSON.stringify({
      type: 'word-prompt',
      difficulty: difficultyName,
      round: String(round),
      prompt: diff.promptPrompt,
    }), 'utf8');

    const challengeJobId = algo.enqueue(promptSig, challengePayload, {
      cacheExpiryMs: diff.promptUrgency,
      refreshRateMs: 300_000,
    });

    // Wait for challenge
    const challengeResult = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Challenge generation timeout')), 30_000);
      algo.subscribe(promptSig, (event: AlgorithmEvent) => {
        if (event.type === 'job_complete' && event.jobId === challengeJobId) {
          clearTimeout(timeout);
          try {
            const parsed = JSON.parse(event.result.toString('utf8'));
            resolve(parsed.content || parsed.summary || '');
          } catch {
            resolve(event.result.toString().slice(0, 200));
          }
        } else if (event.type === 'job_failed' && event.jobId === challengeJobId) {
          clearTimeout(timeout);
          reject(new Error(event.error || 'Challenge generation failed'));
        }
      });
    });

    // Extract answer from challenge
    const answerLine = challengeResult.split('\n').find((l: string) => l.toLowerCase().startsWith('answer:'));
    const answer = answerLine ? answerLine.replace(/^answer:\s*/i, '').trim() : 'unknown';

    console.log('');
    console.log('  ── Round ' + round + '/' + roundCount + ' ──');
    console.log('  ' + challengeResult.replace(/\n/g, '\n  '));
    console.log('');

    // Get player guess
    let guess: string;
    if (autoMode) {
      // Auto mode: use the answer with slight variation
      guess = answer;
      console.log('  [AUTO] Guess: ' + guess);
    } else if (rl) {
      guess = await new Promise<string>((resolve) => {
        rl.question('  Your guess: ', (input: string) => {
          resolve(input.trim());
        });
      });
    } else {
      guess = answer;
    }

    // Validate guess in parallel with scoring
    const validatePayload = Buffer.from(JSON.stringify({
      type: 'word-validate',
      guess,
      challenge: challengeResult,
      prompt: diff.validatePrompt.replace('{guess}', guess).replace('{challenge}', challengeResult),
    }), 'utf8');

    const scorePayload = Buffer.from(JSON.stringify({
      type: 'word-score',
      guess,
      answer,
      challenge: challengeResult,
      prompt: diff.scorePrompt.replace('{guess}', guess).replace('{answer}', answer).replace('{challenge}', challengeResult),
    }), 'utf8');

    const validateJobId = algo.enqueue(validateSig, validatePayload, {
      cacheExpiryMs: diff.validateUrgency,
      refreshRateMs: 300_000,
    });

    const scoreJobId = algo.enqueue(scoreSig, scorePayload, {
      cacheExpiryMs: diff.scoreUrgency,
      refreshRateMs: 300_000,
    });

    // Wait for both
    let isCorrect = false;
    let score = 0;

    await new Promise<void>((resolve) => {
      let validateDone = false;
      let scoreDone = false;

      algo.subscribe(validateSig, (event: AlgorithmEvent) => {
        if (event.type === 'job_complete' && event.jobId === validateJobId) {
          try {
            const parsed = JSON.parse(event.result.toString('utf8'));
            const response = (parsed.content || parsed.summary || '').toUpperCase();
            isCorrect = response.includes('CORRECT') && !response.includes('WRONG');
          } catch {
            isCorrect = guess.toLowerCase() === answer.toLowerCase();
          }
          validateDone = true;
          if (validateDone && scoreDone) resolve();
        } else if (event.type === 'job_failed' && event.jobId === validateJobId) {
          isCorrect = guess.toLowerCase() === answer.toLowerCase();
          validateDone = true;
          if (validateDone && scoreDone) resolve();
        }
      });

      algo.subscribe(scoreSig, (event: AlgorithmEvent) => {
        if (event.type === 'job_complete' && event.jobId === scoreJobId) {
          try {
            const parsed = JSON.parse(event.result.toString('utf8'));
            const text = parsed.content || parsed.summary || '5';
            const numMatch = text.match(/(\d+)/);
            score = numMatch ? parseInt(numMatch[1]) : 5;
          } catch {
            score = isCorrect ? 10 : 3;
          }
          scoreDone = true;
          if (validateDone && scoreDone) resolve();
        } else if (event.type === 'job_failed' && event.jobId === scoreJobId) {
          score = isCorrect ? 10 : 3;
          scoreDone = true;
          if (validateDone && scoreDone) resolve();
        }
      });

      // Timeout
      setTimeout(() => {
        if (!validateDone) { isCorrect = guess.toLowerCase() === answer.toLowerCase(); validateDone = true; }
        if (!scoreDone) { score = isCorrect ? 10 : 3; scoreDone = true; }
        resolve();
      }, 15_000);
    });

    totalScore += score;
    if (isCorrect) correctCount++;

    const icon = isCorrect ? 'CORRECT' : 'WRONG';
    console.log('  ' + icon + '  |  Score: +' + score + '  |  Total: ' + totalScore);
    if (!isCorrect) {
      console.log('  Answer was: ' + answer);
    }

    results.push({
      round,
      challenge: challengeResult.slice(0, 100),
      answer,
      playerGuess: guess,
      correct: isCorrect,
      score,
      wallMs: Date.now() - startTime,
    });
  }

  if (rl) rl.close();

  const totalWallMs = Date.now() - startTime;

  // Collect profile snapshots
  const profileSnaps = [];
  for (const [name, sig] of [['prompt', promptSig], ['validate', validateSig], ['hint', hintSig], ['score', scoreSig]] as [string, Signature][]) {
    const profile = algo.getProfile(sig);
    if (profile) {
      profileSnaps.push({
        name: name as string,
        sampleCount: profile.sampleCount,
        warm: profile.sampleCount >= 2,
        wallEWMA: Math.round(profile.wallTimeMsEWMA),
      });
    }
  }

  // Game over
  console.log('');
  console.log('='.repeat(60));
  console.log('  GAME OVER -- ' + diff.label.toUpperCase());
  console.log('='.repeat(60));
  console.log('');
  console.log('  Rounds:     ' + roundCount);
  console.log('  Correct:    ' + correctCount + '/' + roundCount);
  console.log('  Total Score: ' + totalScore);
  console.log('  Wall time:  ' + (totalWallMs / 1000).toFixed(1) + 's');
  console.log('');

  // Profile learning
  console.log('  PROFILE LEARNING:');
  for (const ps of profileSnaps) {
    console.log('    ' + ps.name.padEnd(12) + ' samples=' + String(ps.sampleCount).padEnd(3) + ' warm=' + String(ps.warm).padEnd(5) + ' wall=' + ps.wallEWMA + 'ms');
  }
  console.log('');

  // Save report
  const report: GameReport = {
    difficulty: difficultyName,
    timestamp: new Date().toISOString(),
    rounds: results,
    totalScore,
    correctCount,
    totalRounds: roundCount,
    wallMs: totalWallMs,
    profileSnapshots: profileSnaps,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, 'wordsmith-' + difficultyName + '-' + Date.now() + '.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('  Report saved: ' + reportPath);

  algo['scheduler'].clearAllRefreshTimers();
  await algo.shutdown();
}

const isMain = process.argv[1]?.includes('wordsmith');
if (isMain) {
  runGame().catch((err) => {
    console.error('Wordsmith failed:', err);
    process.exit(1);
  });
}

export { DIFFICULTIES, RoundResult, GameReport };
