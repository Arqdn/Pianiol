// coach.js — an AI piano teacher that reads your practice stats and tells you what to do next.

import { askJson } from './ai.js';

const COACH_SYSTEM = `You are the practice coach inside Pianiol, a falling-notes piano app. The learner just practised a song in "learn mode" (the app waits at each note until they play the right key). You receive their statistics and reply as a warm, specific, concise piano teacher.

Write "message": 2 to 4 short sentences — first what went well, then the single most useful thing to fix and how to practise it (name concrete bars, keys or habits from the data; never generic filler).
Then a "plan" for the next few minutes: which hand(s) to practise ("right", "left" or "both"), a speed between 0.5 and 1.0 (slower when accuracy is low), and a bar range to loop — startBar and endBar are 1-based and inclusive, at most 8 bars, chosen from the weakest bars (or the whole song if they are doing great). Give the plan a short label such as "Bars 5–8, right hand, slow".`;

const COACH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'plan'],
  properties: {
    message: { type: 'string' },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: ['hands', 'speed', 'startBar', 'endBar', 'label'],
      properties: {
        hands: { type: 'string', enum: ['both', 'right', 'left'] },
        speed: { type: 'number' },
        startBar: { type: 'integer' },
        endBar: { type: 'integer' },
        label: { type: 'string' },
      },
    },
  },
};

const COACH_EXAMPLE = '{"message":"Nice — the right hand in bars 1–4 was clean. Bars 5 and 6 tripped you up: you kept reaching for G4 instead of F#4. Loop them slowly and say the note names out loud.","plan":{"hands":"right","speed":0.6,"startBar":5,"endBar":6,"label":"Bars 5–6, right hand, slow"}}';

export function describePractice(song, stats) {
  const totalBars = Math.max(1, Math.ceil(((song.durationSec || 0) - 0.5) / (stats.barSeconds || 4)));
  const worst = stats.worstBars.map(b => `bar ${b.bar}: ${Math.round(b.accuracy * 100)}% (${b.hits} right, ${b.misses} wrong)`).join('; ') || 'none';
  const wrong = stats.wrongKeys.map(k => `${k.name} ×${k.count}`).join(', ') || 'none';
  return [
    `Song: ${song.title}${song.artist ? ' — ' + song.artist : ''}`,
    `Bars in the song: ${totalBars} (each ${stats.barSeconds.toFixed(1)} s)`,
    `Practised: ${stats.hands} hand(s) at ${stats.speed}× speed for ${stats.practisedSeconds} s, ${stats.loops} loop repeats`,
    `Notes played correctly: ${stats.hits} (${stats.early} of them slightly early); wrong keys pressed: ${stats.misses}; accuracy ${Math.round(stats.accuracy * 100)}%`,
    `Average time to find a note: ${stats.avgReactionMs} ms`,
    `Weakest bars: ${worst}`,
    `Most common wrong keys: ${wrong}`,
  ].join('\n');
}

// Returns { message, plan: { hands, speed, startBar, endBar, startSec, endSec, label } }.
export async function askCoach({ song, stats }, opts = {}) {
  const totalBars = Math.max(1, Math.ceil(((song.durationSec || 0) - 0.5) / (stats.barSeconds || 4)));
  opts.onStatus && opts.onStatus('Asking your coach…');
  const { data } = await askJson(
    { system: COACH_SYSTEM, user: describePractice(song, stats) + '\n\nGive your feedback and plan.', schema: COACH_SCHEMA, jsonExample: COACH_EXAMPLE, maxTokens: 1200 },
    opts,
  );
  const plan = data.plan || {};
  let startBar = Math.max(1, Math.min(totalBars, Math.round(Number(plan.startBar) || 1)));
  let endBar = Math.max(startBar, Math.min(totalBars, Math.round(Number(plan.endBar) || startBar)));
  if (endBar - startBar > 7) endBar = startBar + 7;
  const speed = Math.max(0.4, Math.min(1.25, Number(plan.speed) || 0.75));
  const hands = ['both', 'right', 'left'].includes(plan.hands) ? plan.hands : 'both';
  const bar = stats.barSeconds || 4;
  return {
    message: String(data.message || '').trim() || 'Keep going — loop the weakest bars slowly and speed up as they get clean.',
    plan: {
      hands, speed, startBar, endBar,
      startSec: 0.5 + (startBar - 1) * bar,
      endSec: Math.min(song.durationSec || Infinity, 0.5 + endBar * bar),
      label: String(plan.label || `Bars ${startBar}–${endBar}, ${hands} hand${hands === 'both' ? 's' : ''}, ${speed}×`),
    },
  };
}
