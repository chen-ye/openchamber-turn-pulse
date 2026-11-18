import { describe, expect, test } from 'bun:test';
import type { GuestStatusView } from '@openchamber/sdk';
import { guestStatusViewSchema } from '@openchamber/sdk/schemas';
import {
  applyWireEvent,
  buildStatusView,
  createTrackerStore,
  formatAlignedBarDurations,
  formatAlignedTokPerSec,
} from './main.ts';

const toGlyphMask = (val: string): string => val.replace(/[\d\u2007]/g, 'D');

const assertCleanLayout = (view: GuestStatusView): void => {
  expect(guestStatusViewSchema.safeParse(view).success).toBe(true);
  const barMasks = new Set<string>();
  for (const row of view.rows) {
    if (row.kind !== 'line') continue;
    // Never emit wrapping chips or wrapping badges inside fixed 28px Work Status rows
    expect(row.badge).toBeUndefined();
    expect(row.content?.kind).not.toBe('chips');
    // Never leak raw ses_ IDs as labels
    expect(row.label.startsWith('ses_')).toBe(false);
    // Rows with middle content (chart / bar) omit dot & icon so w-24 columns align
    if (row.content) {
      expect(row.dot).toBeUndefined();
      expect(row.icon).toBeUndefined();
    }
    if (row.content?.kind === 'bar' && row.value) {
      barMasks.add(toGlyphMask(row.value));
    }
  }
  // Every bar row in the view must share identical tabular-figure + punctuation + unit composition
  expect(barMasks.size).toBeLessThanOrEqual(1);
};

describe('Turn Pulse state machine & layout invariants', () => {
  test('walks full multi-step turn without mislabeling post-text gaps as TTFT or wrapping rows', () => {
    const unknownIds: string[] = [];
    const store = createTrackerStore((id) => unknownIds.push(id));
    store.sseConnected = true;
    const t0 = 1_700_000_000_000;

    // 1. Mid-turn event arrives before session.created -> triggers hydration callback, never shows ses_
    applyWireEvent(store, {
      type: 'session.execution.started',
      created: t0,
      location: { directory: '/repo/app' },
      data: { sessionID: 'ses_e3875819abc' },
    }, t0);
    expect(unknownIds).toEqual(['ses_e3875819abc']);

    applyWireEvent(store, {
      type: 'session.step.started',
      created: t0 + 50,
      data: {
        sessionID: 'ses_e3875819abc',
        assistantMessageID: 'msg_1',
        agent: 'orchestrator',
        model: { providerID: 'google', id: 'gemini-4-carbon' },
      },
    }, t0 + 50);

    const s = store.sessions.get('ses_e3875819abc')!;
    expect(s.phase).toBe('waiting-first-token');

    let view = buildStatusView(store, '/repo/app', t0 + 13_100);
    assertCleanLayout(view);
    expect(view.controls).toBeUndefined();
    expect(view.rows[0]?.kind === 'line' && view.rows[0].label).toBe('Waiting for first token');

    // 2. First token arrives at 13.1s via reasoning
    applyWireEvent(store, {
      type: 'session.reasoning.started',
      created: t0 + 13_100,
      data: { sessionID: 'ses_e3875819abc', assistantMessageID: 'msg_1', ordinal: 0 },
    }, t0 + 13_100);

    applyWireEvent(store, {
      type: 'session.reasoning.delta',
      created: t0 + 15_000,
      data: { sessionID: 'ses_e3875819abc', assistantMessageID: 'msg_1', ordinal: 0, delta: 'a'.repeat(400) },
    }, t0 + 15_000);

    expect(s.initialTtftMs).toBe(13_100);
    expect(s.phase).toBe('reasoning');
    view = buildStatusView(store, '/repo/app', t0 + 16_000);
    assertCleanLayout(view);
    expect(view.rows[0]?.kind === 'line' && view.rows[0].label).toBe('Thinking');

    // 3. Gap between reasoning.ended and tool.input.started stays in reasoning, NOT waiting-first-token
    applyWireEvent(store, {
      type: 'session.reasoning.ended',
      created: t0 + 20_000,
      data: { sessionID: 'ses_e3875819abc', assistantMessageID: 'msg_1', ordinal: 0, text: 'done' },
    }, t0 + 20_000);
    expect(s.phase).toBe('reasoning');

    // 4. Tool input -> Tool execution -> Permission gate -> Tool completion
    applyWireEvent(store, {
      type: 'session.tool.input.started',
      created: t0 + 20_200,
      data: { sessionID: 'ses_e3875819abc', assistantMessageID: 'msg_1', id: 'call_1', name: 'edit' },
    }, t0 + 20_200);
    expect(s.phase).toBe('tool-input');
    view = buildStatusView(store, '/repo/app', t0 + 20_400);
    assertCleanLayout(view);
    expect(view.rows[0]?.kind === 'line' && view.rows[0].label).toBe('Tool args · edit');

    applyWireEvent(store, {
      type: 'session.tool.called',
      created: t0 + 20_500,
      data: { sessionID: 'ses_e3875819abc', assistantMessageID: 'msg_1', id: 'call_1', name: 'edit', input: { path: 'service/main.ts' } },
    }, t0 + 20_500);
    expect(s.phase).toBe('tool-running');
    view = buildStatusView(store, '/repo/app', t0 + 20_700);
    assertCleanLayout(view);
    expect(view.rows[0]?.kind === 'line' && view.rows[0].label).toBe('Running · edit (main.ts)');

    applyWireEvent(store, {
      type: 'permission.asked',
      created: t0 + 20_800,
      data: { sessionID: 'ses_e3875819abc', id: 'perm_1', action: 'edit', resources: ['service/main.ts'] },
    }, t0 + 20_800);
    expect(s.phase).toBe('waiting-permission');

    applyWireEvent(store, {
      type: 'permission.replied',
      created: t0 + 21_900,
      data: { sessionID: 'ses_e3875819abc', requestID: 'perm_1' },
    }, t0 + 21_900);
    expect(s.phase).toBe('tool-running');

    applyWireEvent(store, {
      type: 'session.tool.success',
      created: t0 + 22_100,
      data: { sessionID: 'ses_e3875819abc', assistantMessageID: 'msg_1', id: 'call_1', content: 'ok' },
    }, t0 + 22_100);
    // Between tool completion and next step.started -> finalizing, NOT waiting-first-token
    expect(s.phase).toBe('finalizing');
    expect(s.durationsMs.ttft).toBe(13_100);

    // 5. Step 2 starts -> Step 2 TTFT wait -> Streaming reply -> text.ended -> finalizing (never TTFT!)
    applyWireEvent(store, {
      type: 'session.step.started',
      created: t0 + 22_300,
      data: {
        sessionID: 'ses_e3875819abc',
        assistantMessageID: 'msg_2',
        agent: 'orchestrator',
        model: { providerID: 'google', id: 'gemini-4-carbon' },
      },
    }, t0 + 22_300);
    expect(s.phase).toBe('waiting-first-token');
    view = buildStatusView(store, '/repo/app', t0 + 22_800);
    assertCleanLayout(view);
    expect(view.rows[0]?.kind === 'line' && view.rows[0].label).toBe('Step 2 · Waiting for LLM');

    applyWireEvent(store, {
      type: 'session.text.started',
      created: t0 + 23_300,
      data: { sessionID: 'ses_e3875819abc', assistantMessageID: 'msg_2', ordinal: 0 },
    }, t0 + 23_300);

    applyWireEvent(store, {
      type: 'session.text.delta',
      created: t0 + 25_000,
      data: { sessionID: 'ses_e3875819abc', assistantMessageID: 'msg_2', ordinal: 0, delta: 'b'.repeat(600) },
    }, t0 + 25_000);
    expect(s.phase).toBe('streaming-text');
    // Initial TTFT preserved at 13.1s while cumulative LLM wait is 13.1s + 1.0s = 14.1s
    expect(s.initialTtftMs).toBe(13_100);
    expect(s.durationsMs.ttft).toBe(14_100);

    // Text stream ends, 2.8s snapshot finalization before execution.succeeded -> must be finalizing, NOT TTFT!
    applyWireEvent(store, {
      type: 'session.text.ended',
      created: t0 + 30_000,
      data: { sessionID: 'ses_e3875819abc', assistantMessageID: 'msg_2', ordinal: 0, text: 'b'.repeat(600) },
    }, t0 + 30_000);
    expect(s.phase).toBe('finalizing');

    view = buildStatusView(store, '/repo/app', t0 + 32_800);
    assertCleanLayout(view);
    expect(view.rows[0]?.kind === 'line' && view.rows[0].label).toBe('Step 2 · Finishing step');
    // TTFT did NOT grow during the 2.8s finalization gap!
    expect(s.durationsMs.ttft).toBe(14_100);

    // Step ends with 137k input tokens + 450 output tokens -> only output+reasoning counted
    applyWireEvent(store, {
      type: 'session.step.ended',
      created: t0 + 32_850,
      data: {
        sessionID: 'ses_e3875819abc',
        assistantMessageID: 'msg_2',
        finish: 'stop',
        tokens: { input: 136_850, output: 300, reasoning: 150 },
      },
    }, t0 + 32_850);
    expect(s.completedOutputTokens).toBe(450);

    applyWireEvent(store, {
      type: 'session.execution.succeeded',
      created: t0 + 32_900,
      data: { sessionID: 'ses_e3875819abc' },
    }, t0 + 32_900);

    expect(s.phase).toBe('cooldown');
    view = buildStatusView(store, '/repo/app', t0 + 33_500);
    assertCleanLayout(view);
    expect(view.rows[0]?.kind === 'line' && view.rows[0].label).toBe('Turn complete');

    view = buildStatusView(store, '/repo/app', t0 + 36_000);
    assertCleanLayout(view);
    expect(view.rows[0]?.kind === 'line' && view.rows[0].label).toBe('Idle · 2 steps');
  });

  test('tracks parent subagent-wait and uses short Auto label when 2+ workspace sessions have turns', () => {
    const store = createTrackerStore();
    const t0 = 1_700_000_000_000;

    applyWireEvent(store, {
      type: 'session.created',
      created: t0,
      location: { directory: '/repo/app' },
      data: { sessionID: 'ses_parent1', title: 'Primary task' },
    }, t0);
    applyWireEvent(store, {
      type: 'session.execution.started',
      created: t0 + 10,
      location: { directory: '/repo/app' },
      data: { sessionID: 'ses_parent1' },
    }, t0 + 10);
    applyWireEvent(store, {
      type: 'session.execution.succeeded',
      created: t0 + 50,
      location: { directory: '/repo/app' },
      data: { sessionID: 'ses_parent1' },
    }, t0 + 50);

    applyWireEvent(store, {
      type: 'session.created',
      created: t0 + 60,
      location: { directory: '/repo/app' },
      data: { sessionID: 'ses_parent2', title: 'Parallel task' },
    }, t0 + 60);
    applyWireEvent(store, {
      type: 'session.execution.started',
      created: t0 + 70,
      location: { directory: '/repo/app' },
      data: { sessionID: 'ses_parent2' },
    }, t0 + 70);

    applyWireEvent(store, {
      type: 'session.created',
      created: t0 + 80,
      location: { directory: '/repo/app' },
      data: { sessionID: 'ses_child', parentID: 'ses_parent1', title: 'Explore codebase', agent: 'explore' },
    }, t0 + 80);
    applyWireEvent(store, {
      type: 'session.execution.started',
      created: t0 + 100,
      location: { directory: '/repo/app' },
      data: { sessionID: 'ses_child' },
    }, t0 + 100);

    const parent1 = store.sessions.get('ses_parent1')!;
    expect(parent1.phase).toBe('subagent-wait');

    const view = buildStatusView(store, '/repo/app', t0 + 500);
    assertCleanLayout(view);
    expect(view.controls?.[0]?.kind === 'select' && view.controls[0].options[0]?.label).toBe('Auto');
  });

  test('aligns bar duration column and throughput rate to uniform tabular glyph widths', () => {
    const aligned = formatAlignedBarDurations([6_600, 10_200, 648, 6_400, 869]);
    expect(aligned).toEqual([
      '\u20076.6s',
      '10.2s',
      '\u20070.6s',
      '\u20076.4s',
      '\u20070.9s',
    ]);
    expect(new Set(aligned.map(toGlyphMask))).toEqual(new Set(['DD.Ds']));

    const threeDigit = formatAlignedBarDurations([125_400, 6_600, 40]);
    expect(threeDigit).toEqual([
      '125.4s',
      '\u2007\u20076.6s',
      '\u2007\u20070.1s',
    ]);
    expect(new Set(threeDigit.map(toGlyphMask))).toEqual(new Set(['DDD.Ds']));

    const longTurn = formatAlignedBarDurations([1_104_000, 72_000, 7_000]);
    expect(longTurn).toEqual([
      '18:24',
      '\u20071:12',
      '\u20070:07',
    ]);
    expect(new Set(longTurn.map(toGlyphMask))).toEqual(new Set(['DD:DD']));

    expect(formatAlignedTokPerSec(0)).toBe('\u2007\u20070 tok/s');
    expect(formatAlignedTokPerSec(42)).toBe('\u200742 tok/s');
    expect(formatAlignedTokPerSec(131)).toBe('131 tok/s');
  });
});
