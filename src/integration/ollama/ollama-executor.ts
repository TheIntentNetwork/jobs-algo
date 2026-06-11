/**
 * Ollama executor and MC environment helpers.
 *
 * Two paths:
 * 1. OllamaDirectExecutor — calls Ollama HTTP API directly (standalone testing, no MC)
 * 2. ollamaMCEnv() — returns env vars to configure MC's existing Ollama provider
 *    so jobs-algo -> MCAdapter -> mc daemon -> mc_alt_provider_agent.py -> Ollama
 */

import type { CancelToken, MetricsCollector } from '../../types/index.js';
import http from 'node:http';

export interface OllamaDirectConfig {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

interface OllamaChatResponse {
  model: string;
  message?: { role: string; content: string };
  response?: string;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export class OllamaDirectExecutor {
  private config: Required<OllamaDirectConfig>;

  constructor(config: OllamaDirectConfig = {}) {
    this.config = {
      baseUrl: config.baseUrl || 'http://localhost:11434',
      model: config.model || 'qwen2.5:0.5b',
      timeoutMs: config.timeoutMs || 120_000,
      temperature: config.temperature ?? 0.1,
      maxTokens: config.maxTokens || 200,
    };
  }

  getModel(): string { return this.config.model; }

  execute(
    payload: Buffer,
    metrics: MetricsCollector,
    done: (result: Buffer) => void,
    error: (err: Error) => void,
  ): CancelToken {
    let cancelled = false;
    metrics.startWallTimer();

    let prompt = payload.toString('utf8');
    try {
      const parsed = JSON.parse(prompt);
      prompt = parsed.prompt || parsed.text || parsed.message || prompt;
    } catch { /* use raw payload */ }

    const body = JSON.stringify({
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: this.config.temperature, num_predict: this.config.maxTokens },
    });

    const url = new URL('/api/chat', this.config.baseUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 11434,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: this.config.timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (cancelled) return;
        try {
          const resp: OllamaChatResponse = JSON.parse(data);
          const content = resp.message?.content || resp.response || '';
          if (!content) { error(new Error('Empty Ollama response')); return; }

          const totalDuration = resp.total_duration || 0;
          const evalCount = resp.eval_count || 0;
          const promptEvalCount = resp.prompt_eval_count || 0;
          metrics.recordCpu(Math.round(totalDuration / 1000));
          metrics.recordMem(process.memoryUsage().heapUsed);

          done(Buffer.from(JSON.stringify({
            model: resp.model,
            content,
            tokens: { prompt: promptEvalCount, completion: evalCount, total: promptEvalCount + evalCount },
            timing: {
              totalMs: Math.round(totalDuration / 1_000_000),
              loadMs: resp.load_duration ? Math.round(resp.load_duration / 1_000_000) : 0,
              promptEvalMs: resp.prompt_eval_duration ? Math.round(resp.prompt_eval_duration / 1_000_000) : 0,
              evalMs: resp.eval_duration ? Math.round(resp.eval_duration / 1_000_000) : 0,
            },
          }), 'utf8'));
        } catch (err) {
          error(err instanceof Error ? err : new Error('Parse error'));
        }
      });
    });

    req.on('error', (err) => { if (!cancelled) error(err); });
    req.on('timeout', () => { if (!cancelled) { req.destroy(); error(new Error('Ollama timeout')); } });
    req.write(body);
    req.end();

    return { cancel: () => { cancelled = true; req.destroy(); } };
  }
}

/** Build env vars to configure MC for Ollama provider (used with MCAdapter) */
export function ollamaMCEnv(config: OllamaDirectConfig = {}): Record<string, string> {
  return {
    MC_REGISTER_OLLAMA: '1',
    MC_ALT_PROVIDER: 'ollama-local',
    OLLAMA_MODEL: config.model || 'qwen2.5:0.5b',
    OLLAMA_HOST: config.baseUrl || 'http://localhost:11434',
  };
}